import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
SPEC = ROOT / 'local_app/packaging/bdo-suite.spec'
BASE = ROOT / 'tools/warehouse_patch/quantity_templates.npz'


class WarehousePackageAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='warehouse-package-assets-')
        self.root = Path(self.temporary.name)
        self.spec_path = self.root / 'local_app/packaging'
        self.spec_path.mkdir(parents=True)
        bank = self.root / 'barter/recognition_data/trade-templates.json'
        bank.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / 'barter/recognition_data/trade-templates.json', bank)
        self.trade = self.root / 'trade-model'
        self.trade.mkdir()
        for filename in ('inference.onnx', 'inference.yml'):
            (self.trade / filename).write_bytes(b'fixture')
        self.environment = patch.dict(os.environ, {'BDO_PACKAGE_TRADE_MODEL_DIR': str(self.trade)})
        self.environment.start()
        os.environ.pop('BDO_PACKAGE_WAREHOUSE_TEMPLATES', None)

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def load_assets(self):
        namespace = {'SPECPATH': str(self.spec_path)}
        # Run the actual asset selection without starting PyInstaller or its executables.
        source = SPEC.read_text(encoding='utf-8').split('\na = Analysis(', 1)[0]
        exec(compile(source, str(SPEC), 'exec'), namespace)
        return namespace

    def icon_bank(self, *, names=1):
        path = self.root / 'custom-icons.npz'
        np.savez_compressed(path, icons=np.zeros((1, 43, 43, 3), dtype=np.uint8), names=np.array(['checked item'] * names))
        return path

    def test_missing_icon_bank_cannot_fall_back_to_legacy_digits(self):
        base = self.root / 'tools/warehouse_patch/quantity_templates.npz'
        base.parent.mkdir(parents=True)
        shutil.copyfile(BASE, base)
        with self.assertRaisesRegex(RuntimeError, 'Verified warehouse icon references are required'):
            self.load_assets()

    def test_legacy_digit_templates_are_rejected(self):
        os.environ['BDO_PACKAGE_WAREHOUSE_TEMPLATES'] = str(BASE)
        with self.assertRaisesRegex(RuntimeError, 'icon-only reference bank'):
            self.load_assets()

    def test_custom_named_icon_bank_uses_the_runtime_filename(self):
        bank = self.icon_bank()
        os.environ['BDO_PACKAGE_WAREHOUSE_TEMPLATES'] = str(bank)
        assets = self.load_assets()
        for resource in ('local_app/frontend', 'barter/frontend', 'alchemy/frontend'):
            self.assertIn((str(self.root / resource), resource), assets['datas'])
        self.assertIn((str(bank), 'barter/recognition_data'), assets['datas'])
        self.assertEqual(assets['canonicalize_warehouse_data']([
            ('barter/recognition_data/custom-icons.npz', str(bank), 'DATA')]), [
            ('barter/recognition_data/warehouse-icons.npz', str(bank), 'DATA')])

    def test_mismatched_icon_label_counts_are_rejected(self):
        os.environ['BDO_PACKAGE_WAREHOUSE_TEMPLATES'] = str(self.icon_bank(names=2))
        with self.assertRaisesRegex(RuntimeError, 'icon-only reference bank'):
            self.load_assets()
