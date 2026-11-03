import copy
import os
import sys
import types
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
import dialogue_rules
import stt_runtime
import stt_core
import stt_native
from stt_selection import choose_model


class SpeechTests(unittest.TestCase):
    def test_native_reports_unknown_confidence_and_raw_levels(self):
        class Native:
            def decode_pcm(self, x, language):
                self.asserted = (x.dtype, language)
                return 'لا أريد التحويل'
        raw = np.full(16000, .02, dtype=np.float32)
        with patch.object(stt_core, 'speech_spans', return_value=[{'start':0,'end':16000}]):
            text, conf, info = stt_core.decode(Native(), raw)
        self.assertEqual(text, 'لا أريد التحويل')
        self.assertIsNone(conf)
        self.assertFalse(info['confidence_available'])
        self.assertAlmostEqual(info['raw_peak'], .02)
        self.assertEqual(info['raw_clip_pct'], 0)

    def test_native_missing_weights_cannot_download_during_recognition(self):
        from pathlib import Path
        with patch.object(stt_native, 'cache_path', return_value=Path('nonexistent-test-model.gguf')), \
             patch.object(stt_native, 'install') as install:
            with self.assertRaisesRegex(RuntimeError, 'Download'):
                stt_native.load_model('cohere-ar-q5', allow_download=False)
            install.assert_not_called()

    def test_invalid_pcm_is_rejected_before_recognition(self):
        with self.assertRaises(ValueError):
            stt_core.decode(object(), np.array([float('nan')], dtype=np.float32))

    def test_native_silence_does_not_invent_text(self):
        class Native:
            def decode_pcm(self, *args): raise AssertionError('silence must not reach decoder')
        text, _, info = stt_core.decode(Native(), np.zeros(16000,dtype=np.float32))
        self.assertEqual(text, '')
        self.assertFalse(info['speech'])

    def test_dialogue_preserves_scenario_contract(self):
        original = {"system": {"caller": "suspicious cashier"}, "turn": {"language": "Keep {language} and {callerName}."},
                    "repair": {"language": "Keep JSON {schema}."}, "firstPlayerMessages": {"ar": "ألو؟"}, "actions": ["[[hangup]]"]}
        frozen = copy.deepcopy(original)
        result = dialogue_rules.adapt_prompts(original, "Gulf Arabic", short=True)
        self.assertEqual(original, frozen)
        self.assertEqual(result['system'], original['system'])
        self.assertEqual(result['firstPlayerMessages'], original['firstPlayerMessages'])
        self.assertEqual(result['actions'], original['actions'])
        self.assertTrue(result['turn']['language'].startswith(original['turn']['language']))
        self.assertTrue(result['repair']['language'].startswith(original['repair']['language']))
        self.assertEqual(result, dialogue_rules.adapt_prompts(result, "Gulf Arabic", short=True))

    def test_device_failure_keeps_requested_model_and_offline_mode(self):
        calls = []
        class FakeModel:
            def __init__(self, name, **kw): self.device=kw['device']; calls.append((name, kw))
            def transcribe(self, *a, **kw):
                if self.device == 'cuda': raise RuntimeError('cuDNN missing')
                return iter([]), None
        with patch.dict(sys.modules, {'faster_whisper': SimpleNamespace(WhisperModel=FakeModel)}), \
             patch.object(stt_runtime, 'register_runtime'), \
             patch.object(stt_runtime, 'hardware_status', return_value={'cuda_devices': 1, 'compute_types':['int8_float32']}):
            _, info = stt_runtime.load_model('medium')
        self.assertEqual([n for n,_ in calls], ['medium','medium'])
        self.assertTrue(all(kw['local_files_only'] for _,kw in calls))
        self.assertEqual(calls[0][1]['compute_type'], 'int8_float32')
        self.assertEqual(info['device'], 'cpu')
        self.assertIn('cuDNN missing', info['fallback'][0])

    def test_no_speech_skips_whisper(self):
        class NoModel:
            def transcribe(self,*a,**kw): raise AssertionError('Should not decode silence')
        text, conf, _ = stt_core.decode(NoModel(), np.zeros(16000,dtype=np.float32))
        self.assertEqual((text,conf), ('',0))

    def test_real_speech_not_deleted_by_phrase_blacklist(self):
        class Model:
            def transcribe(self,*a,**kw):
                return iter([SimpleNamespace(text='شكرا على المشاهدة',no_speech_prob=0.05,avg_logprob=-0.1,compression_ratio=1)]), None
        cfg=dict(stt_core.IMPROVED,preprocess=False)
        with patch.object(stt_core,'speech_spans',return_value=[{'start':0,'end':16000}]):
            text,_,_=stt_core.decode(Model(),np.full(16000,0.01,dtype=np.float32),cfg)
        self.assertEqual(text,'شكرا على المشاهدة')

    def test_model_selection_rejects_slow_high_accuracy_result(self):
        p, _ = choose_model({'small':{'seconds':1.2,'audio_s':4,'rtf':.3,'cer':.08},
                             'large-v3-turbo':{'seconds':10,'audio_s':4,'rtf':2.5,'cer':.01}})
        self.assertEqual(p,'small')

    def test_model_selection_measures_short_turn_latency(self):
        p, _ = choose_model({'cohere-ar-q5': {'seconds':3.2,'short_seconds':1.3,'audio_s':10,'rtf':.32,'cer':0},
                             'small': {'seconds':1.5,'short_seconds':.8,'audio_s':10,'rtf':.15,'cer':.02}})
        self.assertEqual(p, 'cohere-ar-q5')

    def test_model_selection_does_not_prioritize_rank_over_measured_error(self):
        p,_=choose_model({'small':{'seconds':1,'audio_s':4,'rtf':.25,'cer':.01},
                          'medium':{'seconds':1.5,'audio_s':4,'rtf':.375,'cer':.3}})
        self.assertEqual(p,'small')

if __name__ == '__main__': unittest.main()
