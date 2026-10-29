// Replaces MOSS speech generation with a local helper process (supertts.exe, Supertonic 3).
// Configured through ArabicFix.ini: tts=supertonic, tts_exe=<path>, tts_voices=M1,F1,..., tts_speed, tts_steps, tts_threads
using System;
using System.Collections.Generic;
using System.Text;

namespace ArabicFix
{
    public static class Tts
    {
        private static bool loaded;
        private static bool enabled;
        private static string exePath = "";
        private static string[] voices = new[] { "M1", "F1", "M2", "F2", "M3", "F3", "M4", "F4", "M5", "F5" };
        private static double speed = 1.05;
        private static int steps = 8;
        private static int threads = 4;
        private static System.Diagnostics.Process proc;
        private static System.IO.Stream procOut, procIn;
        private static readonly object gate = new object();

        private static void Load()
        {
            if (loaded) return;
            loaded = true;
            try
            {
                string dir = System.IO.Path.GetDirectoryName(typeof(Tts).Assembly.Location);
                string ini = System.IO.Path.Combine(dir, "ArabicFix.ini");
                if (!System.IO.File.Exists(ini)) return;
                foreach (string raw in System.IO.File.ReadAllText(ini).Split(new[] { (char)10 }))
                {
                    string line = raw.Trim();
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim().ToLowerInvariant(), v = line.Substring(eq + 1).Trim();
                    switch (k)
                    {
                        case "tts": enabled = v.ToLowerInvariant() == "supertonic"; break;
                        case "tts_exe": exePath = v; break;
                        case "tts_voices": if (v.Length > 0) voices = v.Split(','); break;
                        case "tts_speed": speed = ParseDouble(v, speed); break;
                        case "tts_steps": steps = (int)ParseDouble(v, steps); break;
                        case "tts_threads": threads = (int)ParseDouble(v, threads); break;
                    }
                }
                if (enabled && !System.IO.File.Exists(exePath)) enabled = false;
            }
            catch (Exception) { enabled = false; }
        }

        private static double ParseDouble(string v, double fallback)
        {
            double d;
            return double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d) ? d : fallback;
        }

        private static string CurrentLanguage()
        {
            try
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    var t = asm.GetType("Kolkata.Speech.CallLanguage");
                    if (t == null) continue;
                    var cur = t.GetProperty("Current", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static).GetValue(null, null);
                    return cur.GetType().GetProperty("Code").GetValue(cur, null) as string;
                }
            }
            catch (Exception) { }
            return "ar";
        }

        // true -> MOSS must be bypassed for this call
        public static bool Active()
        {
            Load();
            return enabled && CurrentLanguage() == "ar";
        }

        // stand-in for MossOnnxRuntime.ReferenceCodes: only remembers which voice this caller gets
        public static int[] Reference(string path)
        {
            uint h = 2166136261;
            foreach (char c in path ?? "") { h ^= c; h *= 16777619; }
            return new[] { (int)(h & 0x7fffffff) };
        }

        // stand-in for MossOnnxRuntime.Tokenize: the game's text chunker only needs a rough token count
        public static int[] Tokenize(string text)
        {
            return new int[(text == null ? 0 : text.Length) / 3 + 1];
        }

        // start the voice helper in the background so the first sentence is not delayed
        public static void Prewarm()
        {
            Load();
            if (!enabled) return;
            System.Threading.Tasks.Task.Run(() =>
            {
                try { lock (gate) { Start(); } } catch (Exception) { }
            });
        }

        private static void Start()
        {
            if (proc != null && !proc.HasExited) return;
            var psi = new System.Diagnostics.ProcessStartInfo(exePath)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.EnvironmentVariables["SUPERTONIC_INTRA_OP_THREADS"] = threads.ToString();
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            proc = System.Diagnostics.Process.Start(psi);
            proc.ErrorDataReceived += (s, e) => { };
            proc.BeginErrorReadLine();
            procOut = proc.StandardOutput.BaseStream;
            procIn = proc.StandardInput.BaseStream;
            string first = ReadLine();
            if (first != "READY") throw new Exception("voice helper failed to start: " + first);
        }

        private static string ReadLine()
        {
            var bytes = new List<byte>();
            while (true)
            {
                int b = procOut.ReadByte();
                if (b < 0) throw new Exception("voice helper closed");
                if (b == 10) break;
                bytes.Add((byte)b);
            }
            return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\r');
        }

        private static string Escape(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < ' ') sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        // stand-in for MossOnnxRuntime.Generate: synthesizes `text` and pushes 24 kHz float PCM through `emit`
        public static bool Generate(string text, int[] reference, Action<float[]> emit, System.Threading.CancellationToken ct)
        {
            short[] pcm;
            int rate;
            lock (gate)
            {
                Start();
                int idx = (reference != null && reference.Length > 0) ? reference[0] : 0;
                string voice = voices[idx % voices.Length].Trim();
                string req = "{\"text\":\"" + Escape(text) + "\",\"voice\":\"" + voice + "\",\"speed\":"
                    + speed.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ",\"steps\":" + steps + ",\"lang\":\"ar\",\"silence\":0.15}\n";
                byte[] rb = Encoding.UTF8.GetBytes(req);
                procIn.Write(rb, 0, rb.Length);
                procIn.Flush();
                string head = ReadLine();
                if (!head.StartsWith("OK ")) throw new Exception("voice helper error: " + head);
                string[] parts = head.Split(' ');
                int n = int.Parse(parts[1]);
                rate = int.Parse(parts[2]);
                var buf = new byte[n];
                int got = 0;
                while (got < n)
                {
                    int r = procOut.Read(buf, got, n - got);
                    if (r <= 0) throw new Exception("voice helper closed");
                    got += r;
                }
                pcm = new short[n / 2];
                Buffer.BlockCopy(buf, 0, pcm, 0, n - (n % 2));
            }
            ct.ThrowIfCancellationRequested();
            float[] audio = Resample(pcm, rate, 24000);
            const int chunk = 4800; // 0.2 s
            for (int i = 0; i < audio.Length; i += chunk)
            {
                ct.ThrowIfCancellationRequested();
                int len = Math.Min(chunk, audio.Length - i);
                var piece = new float[len];
                Array.Copy(audio, i, piece, 0, len);
                emit(piece);
            }
            return true;
        }

        // Lanczos resampler (44.1 kHz -> 24 kHz)
        private static float[] Resample(short[] input, int from, int to)
        {
            double ratio = (double)from / to;
            int outLen = (int)(input.Length / ratio);
            var o = new float[outLen];
            const int a = 6;
            double cutoff = Math.Max(1.0, ratio);
            for (int n = 0; n < outLen; n++)
            {
                double c = n * ratio;
                int lo = (int)Math.Floor(c - a * cutoff) + 1, hi = (int)Math.Floor(c + a * cutoff);
                double sum = 0, wsum = 0;
                for (int k = lo; k <= hi; k++)
                {
                    if (k < 0 || k >= input.Length) continue;
                    double x = (k - c) / cutoff;
                    double w = Sinc(x) * Sinc(x / a);
                    sum += input[k] * w;
                    wsum += w;
                }
                o[n] = wsum != 0 ? (float)(sum / wsum / 32768.0) : 0f;
            }
            return o;
        }

        private static double Sinc(double x)
        {
            if (Math.Abs(x) < 1e-9) return 1.0;
            double p = 3.14159265358979323846 * x;
            return Math.Sin(p) / p;
        }
    }
}
