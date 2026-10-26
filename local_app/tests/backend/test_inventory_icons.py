import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit
from local_app.backend.app import create_app


class InventoryIconTests(unittest.TestCase):
    def test_all_seventy_existing_reference_icons_are_served_without_altering_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            client = create_app(Path(temporary) / 'test.sqlite3', testing=True).test_client()
            before = client.get('/api/bootstrap').get_json()
            mapping = client.get('/assets/data/inventory-icons.json').get_json()
            catalog = json.loads((Path(__file__).resolve().parents[3] / 'reference/barter_items.json').read_text(encoding='utf-8'))
            self.assertEqual(len(mapping), 70)
            for item in catalog['items']:
                with self.subTest(name=item['programName']):
                    response = client.get(mapping[item['programName']])
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.mimetype, 'image/webp')
                    self.assertEqual(hashlib.sha256(response.data).hexdigest(), item['iconSha256'])
                    self.assertEqual(urlsplit(mapping[item['programName']]).netloc, '')
                    response.close()
            self.assertEqual(client.get('/assets/item-icons/999999999.webp').status_code, 404)
            self.assertEqual(client.get('/api/bootstrap').get_json(), before)
