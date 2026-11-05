import unittest
from contextlib import closing
from local_app.tests.backend import test_alchemy_storage as fixture
from alchemy.catalog import AlchemyError

class WorkbenchTests(unittest.TestCase):
    setUp = fixture.AlchemyStorageTests.setUp
    tearDown = fixture.AlchemyStorageTests.tearDown
    change = fixture.AlchemyStorageTests.change

    def test_record_only_finish_correct_cancel_preserve_inventory_and_ledger(self):
        before = self.store.export()['tables']
        self.change('inventory', changes=[{'item_id':'B','quantity':None}])
        untouched = self.store.export()['tables']
        job = self.change('start', recipe_id='a', calls=10, track_inventory=False)['job']
        self.store = type(self.store)(self.path)
        self.change('finish', job_id=job['job_id'], executed_calls=4, outputs={'A':9,'X':1})
        self.change('correct', job_id=job['job_id'], outputs={'A':10}, reason='actual')
        other = self.change('start', recipe_id='a', calls=5, track_inventory=False)['job']
        self.change('cancel', job_id=other['job_id'])
        after = self.store.export()['tables']
        self.assertEqual(after['inventory'],untouched['inventory'])
        self.assertEqual(after['ledger'],untouched['ledger'])
        self.assertTrue(self.store.validate_backup(self.store.export())['valid'])
        with closing(self.store.connect()) as db:
            stats=list(self.store._yield_statistics(db).values())
        self.assertEqual((stats[0]['total_calls'],stats[0]['total_output']),(4,10))

    def test_default_still_tracks_and_rejects_bad_mode(self):
        with self.assertRaises(AlchemyError):
            self.change('start', recipe_id='a', calls=10, track_inventory='false')
        job=self.change('start', recipe_id='a', calls=10)['job']
        self.assertTrue(job['track_inventory'])
        self.assertEqual(self.store.snapshot()['inventory']['B'],80)

    def test_explicit_standalone_job_ignores_hidden_legacy_goal_reservations(self):
        self.change('goal', item_id='F', quantity=100, priority=0)
        with self.assertRaises(AlchemyError):
            self.change('start', recipe_id='a', calls=10)
        job=self.change('start', recipe_id='a', calls=10, track_inventory=True)['job']
        self.assertIsNone(job['goal_id'])
        self.assertEqual(self.store.snapshot()['inventory']['B'],80)
