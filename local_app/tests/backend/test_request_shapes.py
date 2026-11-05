from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from local_app.backend.app import create_app

class RequestShapeTests(unittest.TestCase):
 def test_invalid_nested_inputs_are_json_errors_and_never_modify_tables(self):
  with TemporaryDirectory() as temp:
   app=create_app(Path(temp)/'barter.sqlite3',testing=True)
   client=app.test_client();store=app.extensions['alchemy_storage'];store.snapshot()
   catalog=client.get('/api/alchemy/catalog?full=1').get_json()
   cases=[]
   for value in [None,False,0,'text',[],[None]]:
    cases.append(('mutations/inventory',{'changes':[value]}))
    for action in ['finish','cancel','correct']:cases.append(('mutations/'+action,{'job_id':value}))
    cases.append(('mutations/start',{'recipe_id':catalog['recipes'][0]['recipe_id'],'calls':1,'substitutions':value}))
    for field in ['items','recipes']:
     bad=deepcopy(catalog);bad[field]=[value];cases.append(('catalog/preview',bad))
    for field in ['inputs','source_evidence']:
     bad=deepcopy(catalog);bad['recipes'][0][field]=[value];cases.append(('catalog/preview',bad))
    bad=deepcopy(catalog);bad['recipes'][0]['output_range']=value;cases.append(('catalog/preview',bad))
   for value in [None,False,0,"text",{},[None]]:
    bad=deepcopy(catalog);bad["items"][0]["aliases"]=value;cases.append(("catalog/preview",bad))
   for n,(path,fields) in enumerate(cases):
    with self.subTest(path=path,index=n):
     before=(store.snapshot()["revision"],store.export()["tables"])
     body={'mutationId':'shape-'+str(n),'baseRevision':0,**fields} if path.startswith('mutations/') else fields
     response=client.post('/api/alchemy/'+path,json=body,base_url='http://localhost:18765',headers={'Origin':'http://localhost:18765'})
     self.assertGreaterEqual(response.status_code,400);self.assertLess(response.status_code,500)
     self.assertTrue(response.is_json);self.assertEqual((store.snapshot()["revision"],store.export()["tables"]),before)
