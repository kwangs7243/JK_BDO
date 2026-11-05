import unittest
from local_app.native_win32 import Win32CapturePlatform, ROI_READY_COLOR, ROI_CAPTURE_COLOR

class CaptureFeedbackTests(unittest.TestCase):
 def platform(self):
  p=object.__new__(Win32CapturePlatform);p.capture_feedback=None;p.capture_flash_until=0
  return p
 def test_only_new_success_flashes_and_time_expires_without_poll_extension(self):
  p=self.platform();self.assertEqual(p._capture_feedback_color(1,0,True,0),ROI_READY_COLOR)
  self.assertEqual(p._capture_feedback_color(1,1,True,1),ROI_CAPTURE_COLOR)
  self.assertEqual(p._capture_feedback_color(1,1,True,1.2),ROI_CAPTURE_COLOR)
  self.assertEqual(p._capture_feedback_color(1,1,True,1.46),ROI_READY_COLOR)
  self.assertEqual(p._capture_feedback_color(1,1,True,2),ROI_READY_COLOR)
 def test_repeated_capture_restarts_pulse_but_context_and_stop_reset_it(self):
  p=self.platform();p._capture_feedback_color(1,0,True,0);p._capture_feedback_color(1,1,True,1)
  self.assertEqual(p._capture_feedback_color(1,2,True,1.3),ROI_CAPTURE_COLOR)
  self.assertEqual(p._capture_feedback_color(1,2,True,1.6),ROI_CAPTURE_COLOR)
  self.assertEqual(p._capture_feedback_color(2,2,True,1.61),ROI_READY_COLOR)
  self.assertEqual(p._capture_feedback_color(2,3,False,2),ROI_READY_COLOR)
  self.assertEqual(p._capture_feedback_color(2,3,True,2.1),ROI_READY_COLOR)
