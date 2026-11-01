import unittest
import importlib.util
from unittest.mock import Mock, patch
import numpy as np
from PIL import Image
from barter.tools.numeric_ocr import decide_number, warehouse_number_key, NumericOCR


class NumericOCRSafetyTests(unittest.TestCase):
    def test_full_width_retry_keeps_visual_validation_on_the_original_slot(self):
        reader=Mock();reader.read_many.return_value=[('41',.8),('41',.99)];reader.read.return_value=('41',.99)
        ocr=NumericOCR(reader);ocr.bank_data={};ocr.warehouse_bank={};ocr.visual=Mock()
        ocr.visual.warehouse.return_value=None
        ocr.visual.outlined_warehouse.return_value={'value':41,'completeToken':True,'digits':[]}
        source=Image.new('RGB',(43,43));whole=Image.new('RGB',(60,30));glyph=Image.new('RGB',(20,15))
        with patch('barter.tools.numeric_ocr.number_views',return_value=[('whole',whole),('glyphs',glyph)]):
            self.assertEqual(ocr.read_many([source],warehouse=True)[0]['value'],41)
        ocr.visual.outlined_warehouse.assert_called_once_with(source)

    def test_outlined_visual_proof_needs_agreement_with_the_complete_ocr_number(self):
        for actual, expected in [(47,None),(41,41)]:
            reader=Mock();reader.read_many.side_effect=lambda images:[(str(actual),.999) for _ in images]
            ocr=NumericOCR(reader);ocr.bank_data={};ocr.warehouse_bank={};ocr.visual=Mock()
            ocr.visual.warehouse.return_value=None
            ocr.visual.outlined_warehouse.return_value={'value':41,'completeToken':True,'digits':[]}
            im=Image.new('RGB',(43,43))
            with patch('barter.tools.numeric_ocr.number_views',return_value=[('whole',im),('glyphs',im)]):
                result=ocr.read_many([im],warehouse=True)[0]
            self.assertEqual(result['value'],expected)

    def test_touching_digits_preserve_both_digits_instead_of_becoming_one_component(self):
        import json
        from pathlib import Path
        from barter.tools.visual_numbers import VisualNumbers
        from barter.tools.trade_template_reader import unpacked_mask
        bank=json.loads((Path(__file__).resolve().parents[3]/'barter/recognition_data/trade-templates.json').read_text(encoding='utf-8'))
        one=unpacked_mask(next(e for e in bank['digitGlyphs'] if e['context']=='warehouse' and e['value']==1))
        run=np.concatenate([one,one],axis=1)
        self.assertEqual(VisualNumbers(bank['digitGlyphs']).match_run(run)['value'],11)
        unrelated=np.concatenate([one,np.zeros((one.shape[0],10),dtype=bool),one],axis=1)
        self.assertIsNone(VisualNumbers(bank['digitGlyphs']).match_run(unrelated))

    def test_audited_locks_are_non_items_and_item_icons_are_never_suppressed(self):
        ocr = NumericOCR(Mock())
        ocr._load_bank()
        for entry, pixels in ocr.non_items:
            self.assertEqual(ocr.non_item(Image.fromarray(pixels))['kind'], entry['kind'])
        from tools.warehouse_patch.warehouse_patch import load_reference
        from pathlib import Path
        _, icons = load_reference(Path(__file__).resolve().parents[3]/'reference/barter_items.json')
        for icon in icons:
            self.assertIsNone(ocr.non_item(Image.fromarray(np.rint(icon*255).astype(np.uint8))))

    @unittest.skipUnless(importlib.util.find_spec('cv2'), 'run in the OCR environment')
    def test_the_same_wrong_ocr_answer_in_every_view_remains_a_proposal(self):
        reader = Mock()
        reader.read_many.side_effect = lambda images: [("47", .999) for _ in images]
        ocr = NumericOCR(reader)
        ocr.bank_data = {}
        from barter.tools.visual_numbers import VisualNumbers
        ocr.visual = VisualNumbers([])
        ocr.warehouse_bank = {}
        image = Image.new('RGB', (43,43)); image.paste('white', (32,28,38,40))
        result = ocr.read_many([image], warehouse=True)[0]
        self.assertIsNone(result['value'])
        self.assertEqual(result['candidate'], 47)
        self.assertEqual(result['status'], 'QUANTITY_UNKNOWN')

    @unittest.skipUnless(importlib.util.find_spec('cv2'), 'run in the OCR environment')
    def test_unseen_quantity_can_use_audited_glyphs_without_any_inference(self):
        import json
        from pathlib import Path
        from barter.tools.visual_numbers import VisualNumbers
        bank = json.loads((Path(__file__).resolve().parents[3]/'barter/recognition_data/trade-templates.json').read_text(encoding='utf-8'))
        from barter.tools.trade_template_reader import unpacked_mask
        one = next(e for e in bank['digitGlyphs'] if e['context']=='warehouse' and e['value']==1)
        mask = unpacked_mask(one)
        pixels = np.zeros((43,43,3), dtype=np.uint8)
        pixels[28:28+mask.shape[0],32:32+mask.shape[1]] = mask[:,:,None]*255
        image = Image.fromarray(pixels); reader = Mock(); ocr = NumericOCR(reader)
        ocr.warehouse_bank = {}
        self.assertEqual(ocr.read_many([image], warehouse=True)[0]['value'],1)
        reader.read_many.assert_not_called()
        pixels[28:28+mask.shape[0],24:24+mask.shape[1]] = mask[:,:,None]*130
        self.assertIsNone(VisualNumbers(bank['digitGlyphs']).warehouse(Image.fromarray(pixels)))
        pixels[28:28+mask.shape[0],24:24+mask.shape[1]] = mask[:,:,None]*255
        pixels[28:28+mask.shape[0],32:32+mask.shape[1]] = mask[:,:,None]*130
        self.assertIsNone(VisualNumbers(bank['digitGlyphs']).warehouse(Image.fromarray(pixels)))

    def test_whole_slot_templates_preserve_a_faint_leading_digit_and_skip_inference(self):
        pixels = np.zeros((43,43,3), dtype=np.uint8)
        pixels[28:40,32:39] = 240
        single = Image.fromarray(pixels)
        pixels[28:40,24:28] = 130
        complete = Image.fromarray(pixels)
        self.assertNotEqual(warehouse_number_key(single), warehouse_number_key(complete))
        reader = Mock()
        ocr = NumericOCR(reader)
        ocr.warehouse_bank = {warehouse_number_key(complete):[{"value":16,"referenceId":"audited-original"}]}
        result = ocr.read_many([complete], warehouse=True)[0]
        self.assertEqual(result['value'],16)
        self.assertEqual(result['valueSource'],'VERIFIED_TEMPLATE')
        reader.read_many.assert_not_called()
        reader.read.assert_not_called()

    def test_leading_digit_conflict_cannot_become_a_single_digit(self):
        result = decide_number([("whole", ("53", .99)), ("mask", ("3", .99)), ("inverse", ("3", .99))])
        self.assertIsNone(result["value"])

    def test_real_warehouse_whole_number_cannot_lose_to_confident_crops(self):
        for full, cropped, confidence in [("16", "6", .8309), ("17", "7", .8563), ("41", "47", .9687)]:
            with self.subTest(full=full):
                result = decide_number([("whole", (full, confidence)), ("glyphs", (cropped, .999)),
                                        ("tight-color", (cropped, .998))], require_whole=True)
                self.assertIsNone(result["value"])

    def test_warehouse_crops_need_a_complete_number_confirmation(self):
        readings = [("whole", ("", 0)), ("glyphs", ("6", .999)), ("tight-color", ("6", .999))]
        self.assertIsNone(decide_number(readings, require_whole=True)["value"])
        readings.append(("full-width:whole", ("6", .99)))
        self.assertEqual(decide_number(readings, require_whole=True)["value"], 6)

    def test_strong_disagreement_overrides_a_majority(self):
        result = decide_number([("whole", ("143", .99)), ("mask", ("43", .999)), ("inverse", ("43", .999))])
        self.assertIsNone(result["value"])

    def test_padding_only_is_not_an_independent_visual_confirmation(self):
        result = decide_number([("whole", ("3", .99)), ("full-width:whole", ("3", .99))])
        self.assertIsNone(result["value"])

    def test_uncertain_numbers_are_not_zero(self):
        self.assertIsNone(decide_number([("whole", ("", 0)), ("mask", ("0", .4))])["value"])
        self.assertEqual(decide_number([("whole", ("0", .99)), ("mask", ("0", .99))])["value"], 0)

    def test_complete_agreement_retains_raw_evidence(self):
        result = decide_number([("whole", ("53", .99)), ("mask", ("53", .98))])
        self.assertEqual(result["value"], 53)
        self.assertEqual(result["rawOCR"], "53")
        self.assertEqual(len(result["variants"]), 2)

    def test_letters_and_out_of_range_values_are_never_forced_into_numbers(self):
        self.assertIsNone(decide_number([("whole", ("S3", .99)), ("mask", ("S3", .99))])["value"])
        self.assertIsNone(decide_number([("whole", ("10000", .99)), ("mask", ("10000", .99))])["value"])
        self.assertIsNone(decide_number([("whole", ("-5", .99)), ("mask", ("-5", .99))])["value"])

    def test_integer_counter_separators_preserve_every_digit_and_raw_reading(self):
        result = decide_number([("whole", ("1,234", .99)), ("mask", ("1234", .99))])
        self.assertEqual(result["value"], 1234)
        self.assertEqual(result["rawOCR"], "1,234")
