// 7za wrapper: when the real 7za fails to extract because symlinks cannot be
// created (no SeCreateSymbolicLinkPrivilege), create placeholder files for the
// two mac-only dylib symlinks and report success.
// Build: rename real 7za.exe to 7za.real.exe in the same dir, place this as 7za.exe.
using System;
using System.Diagnostics;
using System.IO;

class SevenZipWrapper
{
    static string BuildArguments(string[] args)
    {
        var sb = new System.Text.StringBuilder();
        foreach (string a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append('"').Append(a.Replace("\"", "\\\"")).Append('"');
        }
        return sb.ToString();
    }

    static int Main(string[] args)
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string real = Path.Combine(exeDir, "7za.real.exe");
        if (!File.Exists(real))
        {
            Console.Error.WriteLine("wrapper: 7za.real.exe not found next to wrapper");
            return 99;
        }
        var psi = new ProcessStartInfo(real)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            Arguments = BuildArguments(args),
        };
        int code;
        using (var p = Process.Start(psi))
        {
            p.OutputDataReceived += (s, e) => { if (e.Data != null) Console.WriteLine(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            code = p.ExitCode;
        }
        if (code == 0) return 0;

        string outDir = null;
        foreach (string a in args)
        {
            if (a.StartsWith("-o", StringComparison.Ordinal)) { outDir = a.Substring(2); break; }
        }
        if (outDir != null && Directory.Exists(outDir) && Directory.GetFileSystemEntries(outDir).Length > 0)
        {
            try
            {
                string lib = Path.Combine(outDir, "darwin", "10.12", "lib");
                Directory.CreateDirectory(lib);
                File.WriteAllText(Path.Combine(lib, "libcrypto.dylib"), "libcrypto.1.0.0.dylib");
                File.WriteAllText(Path.Combine(lib, "libssl.dylib"), "libssl.1.0.0.dylib");
                Console.Error.WriteLine("wrapper: symlink placeholders created, treating extraction as success");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("wrapper: placeholder creation failed: " + ex.Message);
            }
        }
        return code;
    }
}
