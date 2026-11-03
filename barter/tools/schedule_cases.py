"""Export immutable scheduler cases from read-only history, backups or bootstrap JSON."""
from __future__ import annotations

import argparse
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import zipfile

from barter.backend.schedule_history import TRADE_KEYS, canonical, digest


def from_bootstrap(bootstrap, provenance):
    session = bootstrap.get('workingSession')
    if not session or not session.get('scannedTrades'):
        return None
    settings = bootstrap['settings']
    missing = [key for key in ('inventory','settings') if key not in bootstrap]
    missing += [key for key in ('config','remainingParley') if key not in session]
    if missing:
        raise ValueError('incomplete scheduler input: '+','.join(missing))
    defaults = []
    engine_settings = {key: deepcopy(settings[key]) for key in ('tierRules','navigation','tradePolicy') if key in settings}
    if 'tradePolicy' not in engine_settings:
        engine_settings['tradePolicy'] = {'excludedOutputs':[],'autoExcludeUnregisteredOutputs':False}
        defaults.append('LEGACY_NO_TRADE_POLICY: empty explicit exclusions')
    if 'navigation' in engine_settings:
        engine_settings['navigation']['memos'] = []
    if set(engine_settings) != {'tierRules','navigation','tradePolicy'}:
        raise ValueError('missing stored engine settings')
    value = {'inventory':[{k: row[k] for k in ('programName','tier','stock','target')} for row in bootstrap['inventory']],
             'scannedTrades':[{k: t[k] for k in TRADE_KEYS if k in t} for t in session['scannedTrades']],
             'config':deepcopy(session['config']),'remainingParley':session['remainingParley'],
             'settings':engine_settings,'inputRevision':bootstrap.get('revision')}
    identity = {k:v for k,v in value.items() if k != 'inputRevision'}
    group = digest(sorted([{k:t.get(k) for k in ('island','fromItem','toItem','reqAmount','yield')}
                           for t in value['scannedTrades']], key=canonical))
    completed = {mode:sum(bool(t.get('completed')) for s in voyages for t in s['trades'])
                 for mode,voyages in (session.get('schedule') or {}).items()}
    return {'caseId':digest(identity),'sessionId':session['id'],'offerGroup':group,
            'input':value,'provenance':{**provenance,'normalizations':defaults,'recordedCompleted':completed,
                                      'evaluationPhase':'IN_PROGRESS' if any(completed.values()) else 'NO_RECORDED_COMPLETION'}}


def database_cases(path, provenance, *, current=False):
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as db:
        db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        result = []
        if 'schedule_generation' in tables:
            for row in db.execute('SELECT case_id,session_id,offer_group,input_json,output_json,provenance_json FROM schedule_generation ORDER BY rowid'):
                result.append({'caseId':row[0],'sessionId':row[1],'offerGroup':row[2],'input':json.loads(row[3]),
                               'recordedOutput':json.loads(row[4]),'provenance':{**provenance,**json.loads(row[5])}})
        if current or not result:
            row = db.execute('SELECT payload_json FROM working_session WHERE id=1').fetchone()
            session = json.loads(row[0]) if row else None
            if session:
                catalog = json.loads((Path(__file__).resolve().parents[2]/'reference/barter_items.json').read_text(encoding='utf-8'))
                tiers = {item['programName']:item['tier'] for item in catalog['items']}
                inventory = [dict(programName=name,tier=tiers[name],stock=stock,target=target)
                             for name,stock,target in db.execute('SELECT program_name,stock,target FROM inventory ORDER BY program_name')]
                settings = {name:json.loads(payload) for name,payload in db.execute('SELECT section,payload_json FROM settings')}
                revision = db.execute('SELECT revision FROM app_meta WHERE id=1').fetchone()[0]
                value = from_bootstrap({'workingSession':session,'inventory':inventory,'settings':settings,'revision':revision},provenance)
                if value:result.append(value)
        return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path)
    parser.add_argument('--backups',type=Path)
    parser.add_argument('--bootstrap',type=Path,action='append',default=[])
    parser.add_argument('--include-current',action='store_true')
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    if args.out.exists():parser.error('output exists; choose a new path')
    if not (args.database or args.backups or args.bootstrap):parser.error('a read-only input is required')
    cases=[];failures=[]
    if args.database:cases+=database_cases(args.database,{'kind':'DATABASE','path':str(args.database)},current=args.include_current)
    for path in args.bootstrap:
        case=from_bootstrap(json.loads(path.read_text(encoding='utf-8-sig')),{'kind':'BOOTSTRAP','path':str(path)})
        if case:cases.append(case)
    if args.backups:
        for path in sorted(args.backups.glob('*/user-data-before.zip')):
            try:
                with tempfile.TemporaryDirectory(prefix='bdo-case-export-') as temporary,zipfile.ZipFile(path) as archive:
                    names=[name for name in archive.namelist() if name.endswith('BDOBarter/data/bdo.sqlite3')]
                    if len(names)!=1:raise ValueError('ambiguous barter database member')
                    database=Path(temporary)/'case.sqlite3'
                    with archive.open(names[0]) as src,database.open('wb') as dst:shutil.copyfileobj(src,dst)
                    with database.open('rb') as stream:sha=hashlib.file_digest(stream,'sha256').hexdigest()
                    cases+=database_cases(database,{'kind':'ARCHIVED_DATABASE','archive':str(path),'member':names[0],'databaseSha256':sha})
            except (ValueError,KeyError,sqlite3.Error,zipfile.BadZipFile) as error:
                failures.append({'path':str(path),'error':str(error)})
    unique={}
    for case in cases:
        identity=digest({k:v for k,v in case['input'].items() if k!='inputRevision'})
        if identity not in unique:unique[identity]=case
    report={'version':1,'cases':list(unique.values()),'failures':failures,
            'summary':{'cases':len(unique),'sessions':len({c['sessionId'] for c in unique.values()}),
                       'offerGroups':len({c['offerGroup'] for c in unique.values()}),'failures':len(failures)}}
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report['summary']))


if __name__=='__main__':main()
