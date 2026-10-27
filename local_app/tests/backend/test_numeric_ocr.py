import unittest
from barter.tools.numeric_ocr import decide_number


class NumericOCRSafetyTests(unittest.TestCase):
    def test_leading_digit_conflict_cannot_become_a_single_digit(self):
        result = decide_number([("whole", ("53", .99)), ("mask", ("3", .99)), ("inverse", ("3", .99))])
        self.assertIsNone(result["value"])

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
