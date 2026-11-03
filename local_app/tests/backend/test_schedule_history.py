from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from local_app.backend.app import create_app
from barter.backend import schedule_history as history


class ScheduleHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bdo-schedule-history-')
        self.path = Path(self.temp.name)/'test.sqlite3'
        self.app = create_app(self.path, testing=True)
        self.client = self.app.test_client()
        self.origin = 'http://127.0.0.1:18765'
        boot = self.client.get('/api/bootstrap', base_url=self.origin).get_json()
        settings = boot['settings']
        inventory = boot['inventory']
        for item in inventory:
            item['stock'] = 100
        row = {'island':'베이루와 섬','fromItem':'갈퀴 꽃 씨앗 주머니','toItem':'괴생물 촉수',
               'reqAmount':1,'count':3,'yield':3,'disabled':False,'deleted':False}
        trade = {'island':row['island'],'originalIndex':0,'fromClean':row['fromItem'],'toClean':row['toItem'],
                 'fromTier':1,'toTier':2,'reqA':1,'mult':3,'execC':3,'isCoin':False,'completed':False}
        self.session = {'version':1,'id':'round-a','scannedTrades':[row],
            'schedule':{'speed':[{'trades':[trade],'reqItems':{row['fromItem']:{'count':3,'tier':1,'isBase':False}},
                                'startWeight':300,'parleyUsed':3*settings['parley']['normalCost'],'totalTime':2.0,'returnTime':1.0,'returnOver':False}],
                        'balance':[]},'completed':None,'remainingParley':1250000,
            'config':{key:settings[key] for key in ('ship','parley','tuning')},
            'selection':{'briefMode':'speed','selectedScheduleSlot':1},
            'diagnostics':{'generatedAt':123,'generationId':'gen-a'}}
        self.input = {'inventory':inventory,'scannedTrades':[row],'config':self.session['config'],
                      'remainingParley':1250000,'settings':{key:settings[key] for key in ('tierRules','navigation','tradePolicy')},'inputRevision':0}
        self.generation = self.generation_for(self.session,self.input)

    def tearDown(self):
        self.temp.cleanup()

    def generation_for(self, session, input_value):
        schedule=history.compact_schedule(session['schedule'])
        return {'version':1,'generationId':session['diagnostics']['generationId'],'sessionId':session['id'],
                'generatedAt':session['diagnostics']['generatedAt'],'input':deepcopy(input_value),
                'output':{'schedule':schedule,'endingInventory':history.ending_inventory(input_value,schedule)}}

    def save(self, generation=True, *, body=None):
        if body is None:
            boot=self.client.get('/api/bootstrap',base_url=self.origin).get_json()
            body={'mutationId':f"save-{boot['revision']}",'baseRevision':boot['revision'],
                  'sessionRevision':boot['sessionRevision'],'session':self.session}
            if generation:body['generation']=self.generation
        response=self.client.put('/api/working-session',json=body,base_url=self.origin,headers={'Origin':self.origin})
        return response,deepcopy(body)

    def summary(self):
        return self.client.get('/api/schedule-history',base_url=self.origin).get_json()

    def test_old_client_save_has_no_case_and_does_not_change_inventory(self):
        before=self.client.get('/api/bootstrap',base_url=self.origin).get_json()
        self.assertEqual(self.save(False)[0].status_code,200)
        after=self.client.get('/api/bootstrap',base_url=self.origin).get_json()
        self.assertEqual(after['inventory'],before['inventory'])
        self.assertEqual(self.summary()['cases'],0)

    def test_generation_is_original_bounded_replayable_and_survives_restart(self):
        response,body=self.save()
        self.assertEqual(response.status_code,200,response.get_data(as_text=True))
        self.assertEqual(self.summary()['cases'],1)
        self.assertLess(self.summary()['bytes'],100000)
        with closing(sqlite3.connect(self.path)) as db:
            value=db.execute('SELECT input_json,output_json,provenance_json FROM schedule_generation').fetchone()
        self.assertEqual(json.loads(value[0]),self.input)
        self.assertEqual(json.loads(value[1]),self.generation['output'])
        self.assertEqual(json.loads(value[2])['kind'],'GENERATED')
        self.assertEqual(json.loads(value[2])['engine']['sha256'],history.engine_manifest()['sha256'])
        restart=create_app(self.path,testing=True).test_client()
        self.assertEqual(restart.get('/api/schedule-history',base_url=self.origin).get_json()['cases'],1)
        replay,_=self.save(body=body)
        self.assertTrue(replay.get_json()['idempotent'])
        self.assertEqual(self.save()[0].status_code,200)
        self.assertEqual(self.summary()['cases'],1)

    def test_changed_input_has_its_own_case_but_revisions_alone_do_not(self):
        self.save()
        self.generation['input']['inputRevision']=123
        self.save()
        self.assertEqual(self.summary()['cases'],1)
        self.input['inventory'][0]['stock']+=1
        self.generation=self.generation_for(self.session,self.input)
        self.save()
        self.assertEqual(self.summary()['cases'],2)
        self.assertEqual(self.summary()['sessions'],1)

    def test_conflict_never_records_and_original_input_is_not_replaced_by_current_stock(self):
        boot=self.client.get('/api/bootstrap',base_url=self.origin).get_json()
        body={'mutationId':'stale','baseRevision':999,'sessionRevision':boot['sessionRevision'],
              'session':self.session,'generation':self.generation}
        self.assertEqual(self.save(body=body)[0].status_code,409)
        self.assertEqual(self.summary()['cases'],0)
        self.save()
        with closing(sqlite3.connect(self.path)) as db:
            recorded=json.loads(db.execute('SELECT input_json FROM schedule_generation').fetchone()[0])
            current=dict(db.execute('SELECT program_name,stock FROM inventory'))
        self.assertEqual(recorded['inventory'][0]['stock'],100)
        self.assertIsNone(current[recorded['inventory'][0]['programName']])

    def test_edited_plan_or_bad_record_is_skipped_without_blocking_session_save(self):
        for mutate in [lambda g:g['output']['schedule']['speed'][0]['trades'][0].update(execC=2),
                       lambda g:g['input'].update(extra='unbounded'),lambda g:g.update(output={})]:
            generation=deepcopy(self.generation);mutate(generation);self.generation=generation
            with self.assertLogs(history.__name__,level='WARNING'):
                self.assertEqual(self.save()[0].status_code,200)
        self.assertEqual(self.summary()['cases'],0)

    def test_record_write_failure_rolls_back_only_the_record(self):
        def fail(db,*args):
            db.execute("INSERT INTO schedule_generation VALUES ('partial','s','g','now','i','e','{}','{}','{}',1)")
            raise RuntimeError('simulated history storage failure')
        with patch.object(history,'record_generation',fail),self.assertLogs(history.__name__,level='WARNING'):
            self.assertEqual(self.save()[0].status_code,200)
        self.assertEqual(self.summary()['cases'],0)
        self.assertEqual(self.client.get('/api/bootstrap',base_url=self.origin).get_json()['workingSession']['id'],'round-a')

    def test_retention_bounds_apply_only_to_generation_history(self):
        store=self.app.extensions['bdo_storage']
        with closing(store.connect()) as db,db,patch.object(history,'MAX_ROUNDS',3),patch.object(history,'MAX_CASES_PER_ROUND',2):
            for round_number in range(5):
                session=deepcopy(self.session);session['id']=f'round-{round_number}'
                for case_number in range(4):
                    value=deepcopy(self.input);value['inventory'][0]['stock']=100+round_number*10+case_number
                    generation=self.generation_for(session,value)
                    history.record_generation(db,generation,session,store.catalog,0)
            self.assertEqual(db.execute('SELECT count(*) FROM schedule_generation').fetchone()[0],6)
            self.assertEqual({r[0] for r in db.execute('SELECT distinct session_id FROM schedule_generation')},{'round-2','round-3','round-4'})
        self.assertEqual(self.client.get('/api/bootstrap',base_url=self.origin).get_json()['revision'],0)


if __name__=='__main__':unittest.main()
