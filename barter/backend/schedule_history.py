"""Bounded, original-generation cases; never reads them back into the live engine."""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
import hashlib
import json
import logging
from pathlib import Path

from .contracts import require_int, validate_json_tree, validate_setting_section

MAX_ROUNDS = 30
MAX_CASES_PER_ROUND = 5
MAX_CASE_BYTES = 512 * 1024
MAX_HISTORY_BYTES = 25 * 1024 * 1024
TRADE_KEYS = ('island','fromItem','toItem','reqAmount','count','yield','disabled','deleted','rawFrom')
PLAN_KEYS = ('island','originalIndex','fromClean','toClean','fromTier','toTier','reqA','mult','execC',
             'isCoin','isSpec','isRandomCoin','isChained','isJit','isWaypoint','consumed')
VOYAGE_KEYS = ('reqItems','startWeight','parleyUsed','totalTime','returnTime','returnOver')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


@lru_cache(maxsize=1)
def engine_manifest():
    root = Path(__file__).resolve().parents[2]
    names = [f'barter/frontend/js/domain/{name}.js' for name in ('constants','routing','scheduler','tier7')]
    names += ['reference/barter_items.json']
    files = {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in names}
    return {'version': 1, 'files': files, 'sha256': digest(files)}


def initialize_history(connection):
    connection.execute('''CREATE TABLE IF NOT EXISTS schedule_generation (
        case_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, offer_group TEXT NOT NULL,
        created_at TEXT NOT NULL, input_hash TEXT NOT NULL, engine_hash TEXT NOT NULL,
        input_json TEXT NOT NULL, output_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
        bytes INTEGER NOT NULL, UNIQUE(engine_hash, input_hash))''')


def compact_schedule(schedule):
    return {mode: [{**{key: sortie[key] for key in VOYAGE_KEYS if key in sortie},
                    'trades': [{key: t[key] for key in PLAN_KEYS if key in t} for t in sortie['trades']]}
                   for sortie in sorties] for mode, sorties in schedule.items()}


def input_for_session(value, session, catalog):
    if not isinstance(value, dict) or set(value) - {'inventory','scannedTrades','config','remainingParley','settings','inputRevision'}:
        raise ValueError('unexpected schedule input fields')
    require_int(value['remainingParley'], 'remainingParley')
    if value['remainingParley'] != session['remainingParley'] or value['config'] != session['config']:
        raise ValueError('generation no longer matches its working snapshot')
    rows = [{key: t[key] for key in TRADE_KEYS if key in t} for t in session['scannedTrades']]
    if rows != value['scannedTrades']:
        raise ValueError('generation trades were edited')
    stock = value['inventory']
    if not isinstance(stock, list) or len(stock) != len(catalog):
        raise ValueError('generation needs the entire inventory')
    seen = set()
    for item in stock:
        if set(item) != {'programName','tier','stock','target'} or catalog.get(item['programName']) != item['tier']:
            raise ValueError('invalid inventory item')
        if item['programName'] in seen:
            raise ValueError('duplicate inventory item')
        seen.add(item['programName'])
        require_int(item['target'], 'target')
        if item['stock'] is not None:
            require_int(item['stock'], 'stock')
    settings = value['settings']
    if set(settings) != {'tierRules','navigation','tradePolicy'}:
        raise ValueError('incomplete engine settings')
    for name, section in settings.items():
        validate_setting_section(name, section, catalog)
    for name, section in value['config'].items():
        validate_setting_section(name, section, catalog)
    if value.get('inputRevision') is not None:
        require_int(value['inputRevision'], 'inputRevision')
    return deepcopy(value)


def ending_inventory(input_value, schedule):
    initial = {i['programName']: deepcopy(i) for i in input_value['inventory']}
    def change(items, name, tier, delta):
        if type(tier) is not int or not 1 <= tier <= 7:
            return
        item = items.setdefault(name, {'programName':name,'tier':tier,'stock':0,'target':0})
        if item['stock'] is not None:
            item['stock'] += delta
    result = {}
    for mode, sorties in schedule.items():
        items = deepcopy(initial)
        for sortie in sorties:
            for trade in sortie['trades']:
                if trade.get('isWaypoint'):
                    c = trade.get('consumed')
                    if c:
                        change(items, c['name'], c['tier'], -c['count'])
                else:
                    change(items, trade['fromClean'], trade['fromTier'], -trade['execC']*trade['reqA'])
                    change(items, trade['toClean'], trade['toTier'], trade['execC']*trade['mult'])
        result[mode] = items
    return result


def record_generation(connection, generation, session, catalog, base_revision):
    if not isinstance(generation, dict) or set(generation) != {'version','generationId','sessionId','generatedAt','input','output'}:
        raise ValueError('invalid generation envelope')
    if generation['version'] != 1 or generation['sessionId'] != session['id']:
        raise ValueError('generation session mismatch')
    if generation['generationId'] != session.get('diagnostics', {}).get('generationId'):
        raise ValueError('generation identity mismatch')
    require_int(generation['generatedAt'], 'generatedAt')
    validate_json_tree(generation, 'generation')
    if len(canonical(generation).encode('utf-8')) > MAX_CASE_BYTES:
        raise ValueError('generation exceeds bounded record size')
    input_value = input_for_session(generation['input'], session, catalog)
    output = {'schedule': compact_schedule(session['schedule'])}
    if generation['output'].get('schedule') != output['schedule']:
        raise ValueError('generation plan was edited')
    output['endingInventory'] = ending_inventory(input_value, output['schedule'])
    if generation['output'] != output:
        raise ValueError('inconsistent generation ending inventory')
    manifest = engine_manifest()
    identity = {key: value for key, value in input_value.items() if key != 'inputRevision'}
    input_hash = digest(identity)
    offer_group = digest(sorted([{key: t.get(key) for key in ('island','fromItem','toItem','reqAmount','yield')}
                                 for t in input_value['scannedTrades']], key=canonical))
    provenance = {'version':1, 'kind':'GENERATED', 'generatedAt':generation['generatedAt'],
                  'generationId':generation['generationId'], 'engine':manifest,
                  'savedBaseRevision':base_revision, 'inputRevision':input_value.get('inputRevision')}
    encoded = [canonical(value) for value in (input_value, output, provenance)]
    size = sum(len(v.encode('utf-8')) for v in encoded)
    if size > MAX_CASE_BYTES:
        raise ValueError('generation exceeds bounded record size')
    case_id = digest({'input': input_hash, 'engine': manifest['sha256']})
    cursor = connection.execute('''INSERT OR IGNORE INTO schedule_generation
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?, ?, ?)''',
        (case_id, session['id'], offer_group, input_hash, manifest['sha256'], *encoded, size))
    if not cursor.rowcount:
        return
    connection.execute('''DELETE FROM schedule_generation WHERE session_id = ? AND rowid NOT IN
        (SELECT rowid FROM schedule_generation WHERE session_id = ? ORDER BY rowid DESC LIMIT ?)''',
        (session['id'],session['id'],MAX_CASES_PER_ROUND))
    connection.execute('''DELETE FROM schedule_generation WHERE session_id NOT IN
        (SELECT session_id FROM schedule_generation GROUP BY session_id ORDER BY max(rowid) DESC LIMIT ?)''', (MAX_ROUNDS,))
    while connection.execute('SELECT coalesce(sum(bytes),0) FROM schedule_generation').fetchone()[0] > MAX_HISTORY_BYTES:
        connection.execute('DELETE FROM schedule_generation WHERE session_id = (SELECT session_id FROM schedule_generation ORDER BY rowid LIMIT 1)')


def try_record_generation(connection, generation, session, catalog, base_revision):
    connection.execute('SAVEPOINT schedule_case')
    try:
        record_generation(connection, generation, session, catalog, base_revision)
    except Exception:
        connection.execute('ROLLBACK TO schedule_case')
        logging.getLogger(__name__).warning('Schedule case was not recorded', exc_info=True)
    finally:
        connection.execute('RELEASE schedule_case')


def history_summary(connection):
    row = connection.execute('''SELECT count(*), count(distinct session_id), count(distinct offer_group),
        coalesce(sum(bytes),0), min(created_at), max(created_at) FROM schedule_generation''').fetchone()
    return {'version':1, 'cases':row[0], 'sessions':row[1], 'offerGroups':row[2], 'bytes':row[3],
            'oldestAt':row[4], 'newestAt':row[5], 'limits':{'sessions':MAX_ROUNDS,'casesPerSession':MAX_CASES_PER_ROUND,'bytes':MAX_HISTORY_BYTES}}
