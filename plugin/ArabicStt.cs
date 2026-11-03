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
        private static string profile = "";
        private static bool debug;
        private static bool forceCpu;
        private static float preRoll = -1f, silenceEnd = -1f;
        private static float partials = -1f;   // seconds between live partial passes; 0 = off
        private static string logPath = "";
        private static string lastError = "";
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
                    else if (k == "stt_profile") profile = v;
                    else if (k == "stt_debug") debug = v == "1";
                    else if (k == "stt_preroll") preRoll = ParseFloat(v, -1f);
                    else if (k == "stt_silence") silenceEnd = ParseFloat(v, -1f);
                    else if (k == "stt_partials") partials = ParseFloat(v, -1f);
                }
                if (helperPath.Length > 0 && !System.IO.File.Exists(helperPath)) helperPath = "";
                if (helperPath.Length > 0) logPath = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(helperPath), "stt-log.jsonl");
            }
            catch (Exception) { }
        }

        private static float ParseFloat(string v, float fallback)
        {
            float f;
            return float.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out f) ? f : fallback;
        }

        private static string FloatField(object target, string name, float value)
        {
            var flags = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
            var f = target.GetType().GetField(name, flags);
            if (f == null || f.FieldType != typeof(float)) return name + "=missing";
            float before = (float)f.GetValue(target);
            if (value >= 0f) f.SetValue(target, value);
            return name + "=" + before.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + (value >= 0f ? ">" + value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) : "");
        }

        // called at the start of WhisperVcPipeline.ApplyCallLanguage: widens the pre-roll (soft word starts), and with the
        // local recogniser stops the 1-second partial passes that only compete with the real sentence for the CPU.
        public static void TunePipeline(object pipeline)
        {
            try
            {
                Load();
                if (pipeline == null || helperPath.Length == 0) return;
                string a = FloatField(pipeline, "preRollSeconds", preRoll);
                string b = FloatField(pipeline, "silenceToFinalizeSeconds", silenceEnd);
                string c = FloatField(pipeline, "partialIntervalSeconds", partials == 0f ? 3600f : partials);
                string d = FloatField(pipeline, "speechRmsThreshold", -1f);
                string e = FloatField(pipeline, "minimumUtteranceSeconds", -1f);
                if (logPath.Length > 0)
                    System.IO.File.AppendAllText(logPath, "{\"event\":\"pipeline\",\"fields\":\"" + a + " " + b + " " + c + " " + d + " " + e + "\"}\n");
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
            psi.EnvironmentVariables["ARABICAI_STT_DEVICE"] = forceCpu ? "cpu" : "auto";
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            if (profile.Length > 0) psi.EnvironmentVariables["ARABICAI_STT_PROFILE"] = profile;
            if (logPath.Length > 0) psi.EnvironmentVariables["ARABICAI_STT_LOG"] = logPath;
            if (debug) psi.EnvironmentVariables["ARABICAI_STT_DEBUG"] = "1";
            proc = System.Diagnostics.Process.Start(psi);
            lastError = "";
            proc.ErrorDataReceived += (s, e) => {
                if (e.Data != null) { lastError += e.Data + " "; if (lastError.Length > 1500) lastError = lastError.Substring(lastError.Length - 1500); }
            };
            proc.BeginErrorReadLine();
            procOut = proc.StandardOutput.BaseStream;
            procIn = proc.StandardInput.BaseStream;
            try
            {
                string first = ReadLine(120000);
                if (first != "READY") throw new Exception("recognition helper failed to start: " + first);
            }
            catch
            {
                Stop();
                forceCpu = true;
                throw;
            }
        }

        private static void Stop()
        {
            try
            {
                if (proc != null && !proc.HasExited)
                {
                    var killer = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("taskkill.exe", "/PID " + proc.Id + " /T /F")
                    { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true });
                    if (killer != null) { killer.WaitForExit(5000); killer.Dispose(); }
                }
            }
            catch (Exception) { try { if (proc != null && !proc.HasExited) proc.Kill(); } catch (Exception) { } }
            if (proc != null) proc.Dispose();
            proc = null;
        }

        private static string ReadLine(int timeoutMs = 60000)
        {
            // Pipe reads have no ReadTimeout. Capture this process's stream so a timed-out
            // reader can never consume a replacement helper's response.
            var stream = procOut;
            var read = System.Threading.Tasks.Task.Run(() =>
            {
                var bytes = new List<byte>();
                while (true)
                {
                    int b = stream.ReadByte();
                    if (b < 0) throw new Exception("recognition helper closed");
                    if (b == 10) break;
                    if (bytes.Count >= 1024 * 1024) throw new Exception("recognition response too large");
                    bytes.Add((byte)b);
                }
                return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd(new[] { '\r' });
            });
            if (!read.Wait(timeoutMs)) throw new TimeoutException("recognition helper timed out");
            return read.Result;
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
                        string head = "{\"n\":" + samples.Length + ",\"lang\":\"ar\",\"prompt\":\"" + Escape(prompt) + "\"}\n";
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
                    catch (Exception error)
                    {
                        try { if (logPath.Length > 0) System.IO.File.AppendAllText(logPath, "{\"event\":\"helper_error\",\"message\":\"" + Escape(error.GetBaseException().Message + " " + lastError) + "\"}\n"); } catch (Exception) { }
                        Stop();
                        forceCpu = true; // retry the same model, never silently substitute a smaller one
                    }
                }
            }
            return "";
        }

        // stand-in for ArmSpeechWorkerClient.TranscribeAsync(model, language, samples, token)
        public static System.Threading.Tasks.Task<ValueTuple<string, float>> TranscribeAsync(string lang, float[] samples, System.Threading.CancellationToken token)
        {
            Load();
            return System.Threading.Tasks.Task.Run(() =>
            {
                float conf;
                string text = Transcribe(samples, out conf);
                return new ValueTuple<string, float>(text, conf);
            }, token);
        }
    }
}
