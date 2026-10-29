// Patches Unity.TextMeshPro.dll and UnityEngine.UIElementsModule.dll so that text setters call ArabicFix.
// usage: ArabicPatch.exe <ArabicFix.dll> <originalsDir> <outDir>
// Always patches from the *original* DLLs in <originalsDir> and writes the result to <outDir>.
using System;
using System.IO;
using System.Linq;
using Mono.Cecil;
using Mono.Cecil.Cil;
using Mono.Cecil.Rocks;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "stt")
        {
            // usage: ArabicPatch stt <ArabicFix.dll> <ScriptsAssDef.dll>   (patched in place)
            try { PatchStt(args[1], args[2]); Console.WriteLine("OK"); return 0; }
            catch (Exception e) { Console.Error.WriteLine("ERROR: " + e.Message); return 1; }
        }
        if ((args.Length == 3 || args.Length == 4) && args[0] == "moss")
        {
            // usage: ArabicPatch moss <ArabicFix.dll> <Kolkata.MossTtsNano.dll> [tts]   (patched in place)
            try { PatchMoss(args[1], args[2], args.Length == 4 && args[3] == "tts"); Console.WriteLine("OK"); return 0; }
            catch (Exception e) { Console.Error.WriteLine("ERROR: " + e.Message); return 1; }
        }
        if (args.Length < 3 || args.Length > 4) { Console.Error.WriteLine("usage: ArabicPatch <ArabicFix.dll> <originalsDir> <outDir> [resolveDir]"); return 2; }
        string fixPath = args[0], origDir = args[1], outDir = args[2];
        ResolveDir = args.Length == 4 ? args[3] : null;
        try
        {
            var fixAsm = AssemblyDefinition.ReadAssembly(fixPath);
            var fixText = fixAsm.MainModule.GetType("ArabicFix.ArabicText").Methods.First(m => m.Name == "Fix");
            var fixUi = fixAsm.MainModule.GetType("ArabicFix.ArabicUi").Methods.First(m => m.Name == "Before");

            PatchTmp(Path.Combine(origDir, "Unity.TextMeshPro.dll"), Path.Combine(outDir, "Unity.TextMeshPro.dll"), origDir, fixText);
            PatchUi(Path.Combine(origDir, "UnityEngine.UIElementsModule.dll"), Path.Combine(outDir, "UnityEngine.UIElementsModule.dll"), origDir, fixUi);
            Console.WriteLine("OK");
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ERROR: " + e.Message);
            return 1;
        }
    }

    private static string ResolveDir;

    // WhisperVcPipeline.ConfigureRecognizer(recognizer, code): call ArabicFix.Stt.Configure before returning
    private static void PatchStt(string fixPath, string dllPath)
    {
        var fixAsm = AssemblyDefinition.ReadAssembly(fixPath);
        var cfg = fixAsm.MainModule.GetType("ArabicFix.Stt").Methods.First(w => w.Name == "Configure");
        var asm = Open(dllPath, Path.GetDirectoryName(dllPath));
        var module = asm.MainModule;
        var type = module.GetType("WhisperVcPipeline");
        var m = type.Methods.First(x => x.Name == "ConfigureRecognizer" && x.Parameters.Count == 2);
        m.Body.SimplifyMacros();
        var il = m.Body.GetILProcessor();
        var cfgRef = module.ImportReference(cfg);
        var ret = m.Body.Instructions.Last(i => i.OpCode == OpCodes.Ret);
        il.InsertBefore(ret, il.Create(OpCodes.Ldarg_0));
        il.InsertBefore(ret, il.Create(OpCodes.Ldarg_1));
        il.InsertBefore(ret, il.Create(OpCodes.Call, cfgRef));
        m.Body.OptimizeMacros();

        // ArmSpeechWorkerClient.TranscribeAsync(model, language, samples, token): answer Arabic with the local helper
        var sttType = fixAsm.MainModule.GetType("ArabicFix.Stt");
        var useHelper = module.ImportReference(sttType.Methods.First(w => w.Name == "UseHelper"));
        var helperAsync = module.ImportReference(sttType.Methods.First(w => w.Name == "TranscribeAsync"));
        var client = module.GetType("ArmSpeechWorkerClient");
        var ta = client.Methods.First(x => x.Name == "TranscribeAsync" && x.Parameters.Count == 4);
        ta.Body.SimplifyMacros();
        var tf = ta.Body.Instructions[0];
        var til = ta.Body.GetILProcessor();
        til.InsertBefore(tf, til.Create(OpCodes.Ldarg_2));
        til.InsertBefore(tf, til.Create(OpCodes.Call, useHelper));
        til.InsertBefore(tf, til.Create(OpCodes.Brfalse, tf));
        til.InsertBefore(tf, til.Create(OpCodes.Ldarg_2));
        til.InsertBefore(tf, til.Create(OpCodes.Ldarg_3));
        til.InsertBefore(tf, til.Create(OpCodes.Ldarg, ta.Parameters[3]));
        til.InsertBefore(tf, til.Create(OpCodes.Call, helperAsync));
        til.InsertBefore(tf, til.Create(OpCodes.Ret));
        ta.Body.OptimizeMacros();
        Save(asm, dllPath);
    }

    private static void PatchMoss(string fixPath, string dllPath, bool tts)
    {
        var fixAsm = AssemblyDefinition.ReadAssembly(fixPath);
        var wait = fixAsm.MainModule.GetType("ArabicFix.TtsPrebuffer").Methods.First(w => w.Name == "ShouldWait");
        var asm = Open(dllPath, Path.GetDirectoryName(dllPath));
        var module = asm.MainModule;
        var type = module.GetType("Kolkata.MossTtsNano.MossTtsSingleton");
        var m = type.Methods.First(x => x.Name == "Update" && x.Parameters.Count == 0);
        var first = m.Body.Instructions[0];
        if (first.OpCode == OpCodes.Ldarg_0 && m.Body.Instructions[1].Operand is MethodReference mr && mr.Name == "ShouldWait")
            throw new Exception("already patched");
        m.Body.SimplifyMacros();
        first = m.Body.Instructions[0];
        var il = m.Body.GetILProcessor();
        var waitRef = module.ImportReference(wait);
        il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
        il.InsertBefore(first, il.Create(OpCodes.Call, waitRef));
        il.InsertBefore(first, il.Create(OpCodes.Brfalse, first));
        il.InsertBefore(first, il.Create(OpCodes.Ret));
        m.Body.OptimizeMacros();
        if (tts) PatchMossTts(fixAsm, module);
        Save(asm, dllPath);
    }

    // Route Arabic speech generation to the local voice helper: skip loading the MOSS models, and replace
    // ReferenceCodes (voice picker) and Generate (audio synthesis). Chunking, pauses and transcript words stay the game's own.
    private static void PatchMossTts(AssemblyDefinition fixAsm, ModuleDefinition module)
    {
        var tts = fixAsm.MainModule.GetType("ArabicFix.Tts");
        var active = module.ImportReference(tts.Methods.First(x => x.Name == "Active"));
        var reference = module.ImportReference(tts.Methods.First(x => x.Name == "Reference"));
        var generate = module.ImportReference(tts.Methods.First(x => x.Name == "Generate"));
        var tokenize = module.ImportReference(tts.Methods.First(x => x.Name == "Tokenize"));
        var type = module.GetType("Kolkata.MossTtsNano.MossOnnxRuntime");

        // constructor: after the base constructor call (field initializers already ran), return early when active
        var ctor = type.Methods.First(x => x.IsConstructor && !x.IsStatic && x.Parameters.Count >= 2);
        ctor.Body.SimplifyMacros();
        var ci = ctor.Body.Instructions;
        int baseCall = -1;
        for (int i = 0; i < ci.Count; i++)
            if (ci[i].OpCode == OpCodes.Call && ci[i].Operand is MethodReference r && r.Name == ".ctor" && r.DeclaringType.FullName == "System.Object") { baseCall = i; break; }
        if (baseCall < 0) throw new Exception("MossOnnxRuntime base constructor call not found");
        var after = ci[baseCall + 1];
        var cil = ctor.Body.GetILProcessor();
        cil.InsertBefore(after, cil.Create(OpCodes.Call, active));
        cil.InsertBefore(after, cil.Create(OpCodes.Brfalse, after));
        cil.InsertBefore(after, cil.Create(OpCodes.Ret));
        ctor.Body.OptimizeMacros();

        // ReferenceCodes(string path) -> int[]
        var rc = type.Methods.First(x => x.Name == "ReferenceCodes" && x.Parameters.Count == 1);
        rc.Body.SimplifyMacros();
        var rf = rc.Body.Instructions[0];
        var ril = rc.Body.GetILProcessor();
        ril.InsertBefore(rf, ril.Create(OpCodes.Call, active));
        ril.InsertBefore(rf, ril.Create(OpCodes.Brfalse, rf));
        ril.InsertBefore(rf, ril.Create(OpCodes.Ldarg_1));
        ril.InsertBefore(rf, ril.Create(OpCodes.Call, reference));
        ril.InsertBefore(rf, ril.Create(OpCodes.Ret));
        rc.Body.OptimizeMacros();

        // Tokenize(string text) -> int[]  (the chunker calls it; the real tokenizer is not loaded)
        var tok = type.Methods.First(x => x.Name == "Tokenize" && x.Parameters.Count == 1);
        tok.Body.SimplifyMacros();
        var tf = tok.Body.Instructions[0];
        var til = tok.Body.GetILProcessor();
        til.InsertBefore(tf, til.Create(OpCodes.Call, active));
        til.InsertBefore(tf, til.Create(OpCodes.Brfalse, tf));
        til.InsertBefore(tf, til.Create(OpCodes.Ldarg_1));
        til.InsertBefore(tf, til.Create(OpCodes.Call, tokenize));
        til.InsertBefore(tf, til.Create(OpCodes.Ret));
        tok.Body.OptimizeMacros();

        // Generate(string text, int[] reference, Action<float[]> emit, CancellationToken ct) -> bool
        var gen = type.Methods.First(x => x.Name == "Generate" && x.Parameters.Count == 4);
        gen.Body.SimplifyMacros();
        var gf = gen.Body.Instructions[0];
        var gil = gen.Body.GetILProcessor();
        gil.InsertBefore(gf, gil.Create(OpCodes.Call, active));
        gil.InsertBefore(gf, gil.Create(OpCodes.Brfalse, gf));
        gil.InsertBefore(gf, gil.Create(OpCodes.Ldarg_1));
        gil.InsertBefore(gf, gil.Create(OpCodes.Ldarg_2));
        gil.InsertBefore(gf, gil.Create(OpCodes.Ldarg_3));
        gil.InsertBefore(gf, gil.Create(OpCodes.Ldarg, gen.Parameters[3]));
        gil.InsertBefore(gf, gil.Create(OpCodes.Call, generate));
        gil.InsertBefore(gf, gil.Create(OpCodes.Ret));
        gen.Body.OptimizeMacros();
    }

    private static AssemblyDefinition Open(string path, string searchDir)
    {
        var resolver = new DefaultAssemblyResolver();
        resolver.AddSearchDirectory(searchDir);
        if (ResolveDir != null) resolver.AddSearchDirectory(ResolveDir);
        return AssemblyDefinition.ReadAssembly(path, new ReaderParameters { AssemblyResolver = resolver });
    }

    private static void Save(AssemblyDefinition asm, string outPath)
    {
        string tmp = outPath + ".new";
        asm.Write(tmp);
        asm.Dispose();
        if (File.Exists(outPath)) File.Delete(outPath);
        File.Move(tmp, outPath);
    }

    private static void PatchTmp(string input, string output, string searchDir, MethodDefinition fix)
    {
        var asm = Open(input, searchDir);
        var module = asm.MainModule;
        var fixRef = module.ImportReference(fix);
        var type = module.GetType("TMPro.TMP_Text");
        int patched = 0;
        foreach (var m in type.Methods)
        {
            bool target =
                (m.Name == "set_text" && m.Parameters.Count == 1) ||
                (m.Name == "SetText" && m.Parameters.Count >= 1 && m.Parameters.Count <= 2 && m.Parameters[0].ParameterType.FullName == "System.String" &&
                 (m.Parameters.Count == 1 || m.Parameters[1].ParameterType.FullName == "System.Boolean"));
            if (!target || !m.HasBody) continue;
            var il = m.Body.GetILProcessor();
            var first = m.Body.Instructions[0];
            il.InsertBefore(first, il.Create(OpCodes.Ldarg_1));
            il.InsertBefore(first, il.Create(OpCodes.Call, fixRef));
            il.InsertBefore(first, il.Create(OpCodes.Starg_S, m.Parameters[0]));
            patched++;
        }
        if (patched == 0) throw new Exception("TMP_Text text setters not found");
        Save(asm, output);
        Console.WriteLine("TMP patched methods: " + patched);
    }

    private static void PatchUi(string input, string output, string searchDir, MethodDefinition before)
    {
        var asm = Open(input, searchDir);
        var module = asm.MainModule;
        var beforeRef = module.ImportReference(before);
        var type = module.GetType("UnityEngine.UIElements.TextElement");
        var m = type.Methods.FirstOrDefault(x => x.Name == "set_text" && x.Parameters.Count == 1);
        if (m == null || !m.HasBody) throw new Exception("TextElement.set_text not found");
        var il = m.Body.GetILProcessor();
        var first = m.Body.Instructions[0];
        il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
        il.InsertBefore(first, il.Create(OpCodes.Ldarg_1));
        il.InsertBefore(first, il.Create(OpCodes.Call, beforeRef));
        Save(asm, output);
        Console.WriteLine("UI Toolkit patched");
    }
}


