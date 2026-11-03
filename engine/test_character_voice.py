import unittest
import numpy as np
from character_voice import tempo, speech_chunks

class CharacterVoiceTests(unittest.TestCase):
    def test_tempo_shortens_audio_without_changing_pitch(self):
        rate=24000
        audio=np.sin(2*np.pi*220*np.arange(rate*2)/rate).astype(np.float32)*.2
        faster=tempo(audio,rate,1.15)
        self.assertTrue(1.68 < len(faster)/rate < 1.79)
        spectrum=np.abs(np.fft.rfft(faster))
        peak=np.argmax(spectrum)*rate/len(faster)
        self.assertLess(abs(peak-220),3)
    def test_chunks_preserve_every_word_and_punctuation(self):
        text=' '.join(['خلني أتأكد من التفاصيل قبل ما أوافق، وبعدها أرد عليك بوضوح.']*4)
        parts=speech_chunks(text)
        self.assertGreater(len(parts),1)
        self.assertEqual(' '.join(parts),text)
        self.assertGreaterEqual(len(parts[0]),45)
    def test_short_reply_stays_intact(self):
        text='طيب فهمت عليك، بس وش المطلوب مني بالضبط؟'
        self.assertEqual(speech_chunks(text),[text])

if __name__=='__main__':unittest.main()
