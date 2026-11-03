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
        private static bool genderAware = true;
        private static string voicesDir = "";
        private static string dataDir = "";
        private static readonly Dictionary<string, char> genderCache = new Dictionary<string, char>();
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
                dataDir = System.IO.Path.GetDirectoryName(dir);
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
                        case "tts_gender": genderAware = v != "0"; break;
                        case "tts_voices_dir": voicesDir = v; break;
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

        // gender of the caller that owns this voice file (default callers: caller-identities, workshop callers: caller.json)
        private static char GenderOf(string path)
        {
            if (!genderAware || string.IsNullOrEmpty(path)) return 'U';
            char g;
            if (genderCache.TryGetValue(path, out g)) return g;
            g = 'U';
            try
            {
                string p = path.Replace('\\', '/');
                if (p.StartsWith("workshop:"))
                {
                    string[] parts = p.Split(':');
                    if (parts.Length >= 3) g = GenderFromFile(FindWorkshopCaller(parts[1], parts[2]));
                }
                else
                {
                    string hash = null;
                    foreach (string seg in p.Split('/')) if (seg.Length == 64) hash = seg;
                    string identities = System.IO.Path.Combine(System.IO.Path.Combine(System.IO.Path.Combine(dataDir, "StreamingAssets"), "kolkata-json"), "caller-identities");
                    if (hash != null)
                        g = GenderFromFile(System.IO.Path.Combine(identities, "default-" + hash + ".json"));
                    else
                        g = GenderByFileName(identities, p.Substring(p.LastIndexOf('/') + 1));
                }
            }
            catch (Exception) { }
            genderCache[path] = g;
            return g;
        }

        // community callers live in set*.json (arrays of identity objects); find the object that mentions the voice and read its gender
        private static char GenderByFileName(string identitiesDir, string fileName)
        {
            int dot = fileName.LastIndexOf('.');
            if (dot > 0) fileName = fileName.Substring(0, dot);
            if (fileName.Length < 3 || !System.IO.Directory.Exists(identitiesDir)) return 'U';
            foreach (string f in System.IO.Directory.GetFiles(identitiesDir, "*.json"))
            {
                string text = System.IO.File.ReadAllText(f);
                int at = text.IndexOf(fileName, StringComparison.OrdinalIgnoreCase);
                if (at < 0) continue;
                // top-level objects: track braces outside of strings
                int depth = 0, start = -1;
                bool inStr = false;
                for (int i = 0; i < text.Length; i++)
                {
                    char c = text[i];
                    if (inStr) { if (c == '\\') i++; else if (c == '"') inStr = false; continue; }
                    if (c == '"') { inStr = true; continue; }
                    if (c == '{') { if (depth == 0) start = i; depth++; }
                    else if (c == '}')
                    {
                        depth--;
                        if (depth == 0 && start >= 0 && at >= start && at <= i)
                        {
                            string obj = text.Substring(start, i - start + 1);
                            int gi = obj.IndexOf("\"gender\"", StringComparison.OrdinalIgnoreCase);
                            if (gi < 0) return 'U';
                            int q1 = obj.IndexOf('"', obj.IndexOf(':', gi) + 1);
                            int q2 = q1 < 0 ? -1 : obj.IndexOf('"', q1 + 1);
                            if (q1 < 0 || q2 < 0) return 'U';
                            string v = obj.Substring(q1 + 1, q2 - q1 - 1).ToLowerInvariant();
                            if (v.StartsWith("fem")) return 'F';
                            if (v.StartsWith("mal")) return 'M';
                            return 'U';
                        }
                    }
                }
            }
            return 'U';
        }

        private static string FindWorkshopCaller(string id, string hash)
        {
            string root = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData");
            root = System.IO.Path.Combine(System.IO.Path.Combine(System.IO.Path.Combine(root, "LocalLow"), "Jatater Worldwide"), "Scam With Your Friends");
            root = System.IO.Path.Combine(root, "Workshop Callers");
            if (!System.IO.Directory.Exists(root)) return null;
            foreach (string d in System.IO.Directory.GetDirectories(root))
            {
                string f = System.IO.Path.Combine(System.IO.Path.Combine(System.IO.Path.Combine(System.IO.Path.Combine(d, "cache"), id), hash), "caller.json");
                if (System.IO.File.Exists(f)) return f;
            }
            return null;
        }

        private static char GenderFromFile(string file)
        {
            if (file == null || !System.IO.File.Exists(file)) return 'U';
            string text = System.IO.File.ReadAllText(file);
            int i = text.IndexOf("\"gender\"", StringComparison.OrdinalIgnoreCase);
            if (i < 0) return 'U';
            int q1 = text.IndexOf('"', text.IndexOf(':', i) + 1);
            if (q1 < 0) return 'U';
            int q2 = text.IndexOf('"', q1 + 1);
            if (q2 < 0) return 'U';
            string v = text.Substring(q1 + 1, q2 - q1 - 1).ToLowerInvariant();
            if (v.StartsWith("fem")) return 'F';
            if (v.StartsWith("mal")) return 'M';
            return 'U';
        }

        private static char VoiceGender(string name)
        {
            name = name.Trim();
            if (name.Length == 0) return 'U';
            char c = char.ToUpperInvariant(name[0]);
            return (c == 'F' || c == 'M') ? c : 'U';
        }

        // stand-in for MossOnnxRuntime.ReferenceCodes: picks which voice this caller gets (by gender when known)
        public static int[] Reference(string path)
        {
            Load();
            // Custom identities keep a deterministic voice rather than entering the random pool.
            try
            {
                string folder = System.IO.Path.GetDirectoryName(path);
                string id = System.IO.Path.GetFileName(folder);
                if (System.Text.RegularExpressions.Regex.IsMatch(id ?? "", "^brave-[a-f0-9]{32}$") &&
                    System.IO.File.Exists(System.IO.Path.Combine(folder, "brave-character.json")))
                {
                    int[] marker = new int[id.Length + 1]; marker[0] = -1;
                    for (int i = 0; i < id.Length; i++) marker[i + 1] = id[i];
                    return marker;
                }
            }
            catch (Exception) { }
            uint h = 2166136261;
            foreach (char c in path ?? "") { h ^= c; h *= 16777619; }
            char g = GenderOf(path);
            var candidates = new List<int>();
            if (g != 'U')
                for (int i = 0; i < voices.Length; i++) if (VoiceGender(voices[i]) == g) candidates.Add(i);
            if (candidates.Count == 0)
                for (int i = 0; i < voices.Length; i++) candidates.Add(i);
            return new[] { candidates[(int)((h & 0x7fffffff) % candidates.Count)] };
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
            psi.EnvironmentVariables["ARABICAI_GAME_DIR"] = System.IO.Path.GetDirectoryName(dataDir);
            try
            {
                string trial = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "brave", "character-trial.json");
                if (System.IO.File.Exists(trial))
                {
                    var match = System.Text.RegularExpressions.Regex.Match(System.IO.File.ReadAllText(trial), "\"id\"\\s*:\\s*\"(brave-[a-f0-9]{32})\"");
                    if (match.Success) psi.EnvironmentVariables["ARABICAI_PREWARM_CHARACTER"] = match.Groups[1].Value;
                }
            }
            catch (Exception) { }
            if (voicesDir.Length > 0) psi.EnvironmentVariables["ARABICAI_VOICES_DIR"] = voicesDir;
            proc = System.Diagnostics.Process.Start(psi);
            proc.ErrorDataReceived += (s, e) => { };
            proc.BeginErrorReadLine();
            procOut = proc.StandardOutput.BaseStream;
            procIn = proc.StandardInput.BaseStream;
            string first = ReadLine();
            if (first != "READY") throw new Exception("voice helper failed to start: " + first);
        }

        private static string ReadLine(System.Threading.CancellationToken ct = default(System.Threading.CancellationToken))
        {
            var stream = procOut;
            var task = System.Threading.Tasks.Task.Run(() =>
            {
                var bytes = new List<byte>();
                while (bytes.Count < 4096)
                {
                    int b = stream.ReadByte();
                    if (b < 0) throw new Exception("voice helper closed");
                    if (b == 10) return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd(new[] { '\r' });
                    bytes.Add((byte)b);
                }
                throw new Exception("voice helper header too large");
            });
            if (!task.Wait(120000, ct)) throw new TimeoutException("voice helper timed out");
            return task.Result;
        }

        private static byte[] ReadAudio(int size, System.Threading.CancellationToken ct = default(System.Threading.CancellationToken))
        {
            if (size < 0 || size > 16 * 1024 * 1024 || size % 2 != 0) throw new Exception("Invalid audio size");
            var stream = procOut;
            var task = System.Threading.Tasks.Task.Run(() =>
            {
                byte[] buffer = new byte[size]; int got = 0;
                while (got < size)
                {
                    int count = stream.Read(buffer, got, size - got);
                    if (count <= 0) throw new Exception("voice helper closed");
                    got += count;
                }
                return buffer;
            });
            if (!task.Wait(30000, ct)) throw new TimeoutException("voice audio timed out");
            return task.Result;
        }

        public static void Stop()
        {
            var old = proc; proc = null; procOut = null; procIn = null;
            if (old == null) return;
            try
            {
                if (!old.HasExited)
                {
                    var kill = new System.Diagnostics.ProcessStartInfo("taskkill.exe", "/PID " + old.Id + " /T /F")
                    { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                    using (var killer = System.Diagnostics.Process.Start(kill)) killer.WaitForExit(3000);
                }
            }
            catch (Exception) { }
            try { old.Dispose(); } catch (Exception) { }
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
            lock (gate)
            {
              try
              {
                ct.ThrowIfCancellationRequested();
                Start();
                int idx = (reference != null && reference.Length > 0) ? reference[0] : 0;
                string character = "";
                if (idx == -1 && reference.Length == 39)
                {
                    char[] chars = new char[38];
                    for (int i = 0; i < chars.Length; i++) chars[i] = (char)reference[i + 1];
                    character = new string(chars);
                    if (!System.Text.RegularExpressions.Regex.IsMatch(character, "^brave-[a-f0-9]{32}$")) throw new Exception("Invalid character voice");
                }
                string voice = voices[Math.Max(0, idx) % voices.Length].Trim();
                string req = "{\"text\":\"" + Escape(text) + "\",\"voice\":\"" + voice + "\",\"speed\":"
                    + speed.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + ",\"steps\":" + steps + ",\"lang\":\"ar\",\"silence\":0.15"
                    + (character.Length > 0 ? ",\"character\":\"" + character + "\",\"stream\":true" : "") + "}\n";
                byte[] rb = Encoding.UTF8.GetBytes(req);
                procIn.Write(rb, 0, rb.Length);
                procIn.Flush();
                string head = ReadLine(ct);
                if (head.StartsWith("STREAM "))
                {
                    int streamRate = int.Parse(head.Substring(7));
                    if (streamRate < 8000 || streamRate > 96000) throw new Exception("Invalid audio rate");
                    int total = 0;
                    while (true)
                    {
                        ct.ThrowIfCancellationRequested();
                        string part = ReadLine(ct);
                        if (part == "END") return true;
                        if (!part.StartsWith("CHUNK ")) throw new Exception("voice helper error: " + part);
                        byte[] block = ReadAudio(int.Parse(part.Substring(6)), ct);
                        total += block.Length;
                        if (total > 16 * 1024 * 1024) throw new Exception("Voice stream exceeded limit");
                        short[] samples = new short[block.Length / 2]; Buffer.BlockCopy(block, 0, samples, 0, block.Length);
                        emit(Resample(samples, streamRate, 24000));
                    }
                }
                if (!head.StartsWith("OK ")) throw new Exception("voice helper error: " + head);
                string[] parts = head.Split(' ');
                int n = int.Parse(parts[1]);
                int rate = int.Parse(parts[2]);
                if (rate < 8000 || rate > 96000) throw new Exception("Invalid audio rate");
                var buf = ReadAudio(n, ct);
                var pcm = new short[n / 2];
                Buffer.BlockCopy(buf, 0, pcm, 0, n - (n % 2));
                ct.ThrowIfCancellationRequested();
                float[] audio = Resample(pcm, rate, 24000);
                const int chunk = 4800;
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
              catch { Stop(); throw; }
            }
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
