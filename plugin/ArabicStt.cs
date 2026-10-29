// Speech-recognition tuning for Arabic calls.
//  1) Whisper (game's built-in): forces the language and gives an "initial prompt" (ConfigureRecognizer hook).
//  2) Local helper: Arabic recognition is sent to supertts.exe --stt (faster-whisper on the CPU) instead of
//     the game's recognizer (ArmSpeechWorkerClient.TranscribeAsync hook).
// Settings come from ArabicFix.ini: stt_language, stt_prompt, stt_helper, stt_model, stt_threads
using System;
using System.Collections.Generic;
using System.Text;

namespace ArabicFix
{
    public static class Stt
    {
        private static bool loaded;
        private static string language = "";
        private static string prompt = "";
        private static string helperPath = "";
        private static string model = "small";
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
                string dir = System.IO.Path.GetDirectoryName(typeof(Stt).Assembly.Location);
                string ini = System.IO.Path.Combine(dir, "ArabicFix.ini");
                if (!System.IO.File.Exists(ini)) return;
                foreach (string raw in System.IO.File.ReadAllText(ini).Split(new[] { (char)10 }))
                {
                    string line = raw.Trim();
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim().ToLowerInvariant(), v = line.Substring(eq + 1).Trim();
                    if (k == "stt_language") language = v;
                    else if (k == "stt_prompt") prompt = v;
                    else if (k == "stt_helper") helperPath = v;
                    else if (k == "stt_model") model = v;
                    else if (k == "stt_threads") { int t; if (int.TryParse(v, out t) && t > 0) threads = t; }
                }
                if (helperPath.Length > 0 && !System.IO.File.Exists(helperPath)) helperPath = "";
            }
            catch (Exception) { }
        }

        private static void Set(object target, string name, string value)
        {
            var flags = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
            var t = target.GetType();
            var f = t.GetField(name, flags);
            if (f != null && f.FieldType == typeof(string)) { f.SetValue(target, value); return; }
            var p = t.GetProperty(name, flags);
            if (p != null && p.CanWrite && p.PropertyType == typeof(string)) p.SetValue(target, value, null);
        }

        // called at the end of WhisperVcPipeline.ConfigureRecognizer(WhisperManager recognizer, string code)
        public static void Configure(object recognizer, string code)
        {
            try
            {
                Load();
                if (recognizer == null || code != "ar") return;
                if (language.Length > 0) Set(recognizer, "language", language);
                if (prompt.Length > 0) Set(recognizer, "initialPrompt", prompt);
            }
            catch (Exception) { }
        }

        // true -> ArmSpeechWorkerClient.TranscribeAsync is answered by the local helper
        public static bool UseHelper(string lang)
        {
            Load();
            return helperPath.Length > 0 && lang == "ar";
        }

        // start the recognition helper in the background (model load + warm-up takes a while)
        public static void Prewarm()
        {
            Load();
            if (helperPath.Length == 0) return;
            System.Threading.Tasks.Task.Run(() =>
            {
                try { lock (gate) { Start(); } } catch (Exception) { }
            });
        }

        private static void Start()
        {
            if (proc != null && !proc.HasExited) return;
            var psi = new System.Diagnostics.ProcessStartInfo(helperPath, "--stt")
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.EnvironmentVariables["ARABICAI_STT_MODEL"] = model;
            psi.EnvironmentVariables["ARABICAI_STT_THREADS"] = threads.ToString();
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            proc = System.Diagnostics.Process.Start(psi);
            proc.ErrorDataReceived += (s, e) => { };
            proc.BeginErrorReadLine();
            procOut = proc.StandardOutput.BaseStream;
            procIn = proc.StandardInput.BaseStream;
            string first = ReadLine();
            if (first != "READY") throw new Exception("recognition helper failed to start: " + first);
        }

        private static string ReadLine()
        {
            var bytes = new List<byte>();
            while (true)
            {
                int b = procOut.ReadByte();
                if (b < 0) throw new Exception("recognition helper closed");
                if (b == 10) break;
                bytes.Add((byte)b);
            }
            return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\r');
        }

        private static string Escape(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s ?? "")
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < ' ') sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static string Transcribe(float[] samples, out float confidence)
        {
            confidence = 0f;
            lock (gate)
            {
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    try
                    {
                        Start();
                        string head = "{\"n\":" + samples.Length + ",\"lang\":\"ar\",\"beam\":1,\"prompt\":\"" + Escape(prompt) + "\"}\n";
                        byte[] hb = Encoding.UTF8.GetBytes(head);
                        procIn.Write(hb, 0, hb.Length);
                        var raw = new byte[samples.Length * 4];
                        Buffer.BlockCopy(samples, 0, raw, 0, raw.Length);
                        procIn.Write(raw, 0, raw.Length);
                        procIn.Flush();
                        string resp = ReadLine();
                        if (!resp.StartsWith("OK ")) throw new Exception(resp);
                        string[] parts = resp.Split(new[] { ' ' }, 3);
                        float c;
                        float.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out c);
                        confidence = c;
                        return parts.Length > 2 && parts[2].Length > 0 ? Encoding.UTF8.GetString(Convert.FromBase64String(parts[2])) : "";
                    }
                    catch (Exception)
                    {
                        try { if (proc != null && !proc.HasExited) proc.Kill(); } catch (Exception) { }
                        proc = null;
                    }
                }
            }
            return "";
        }

        // stand-in for ArmSpeechWorkerClient.TranscribeAsync(model, language, samples, token)
        public static System.Threading.Tasks.Task<ValueTuple<string, float>> TranscribeAsync(string lang, float[] samples, System.Threading.CancellationToken token)
        {
            return System.Threading.Tasks.Task.Run(() =>
            {
                float conf;
                string text = Transcribe(samples, out conf);
                return new ValueTuple<string, float>(text, conf);
            }, token);
        }
    }
}
