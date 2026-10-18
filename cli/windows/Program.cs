using System.Diagnostics;

try {
    var root = AppContext.BaseDirectory;
    var info = new ProcessStartInfo(Path.Combine(root, "DreamEdge.exe")) { UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    info.Environment["ELECTRON_RUN_AS_NODE"] = "1";
    info.ArgumentList.Add(Path.Combine(root, "resources", "app.asar", "dist", "cli", "main.js"));
    foreach (var arg in args) info.ArgumentList.Add(arg);
    using var child = Process.Start(info) ?? throw new IOException("DreamEdge 启动失败。");
    using var inputLifetime = new CancellationTokenSource();
    async Task ForwardInput() {
        try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream, inputLifetime.Token); child.StandardInput.Close(); }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { }
    }
    _ = ForwardInput();
    var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
    var errors = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
    await child.WaitForExitAsync(); inputLifetime.Cancel(); await Task.WhenAll(output, errors);
    return child.ExitCode;
} catch {
    Console.Out.WriteLine("{\"ok\":false,\"error\":{\"code\":\"LAUNCHER_FAILED\",\"message\":\"请完整解压 DreamEdge 应用包后重试。\"}}");
    return 1;
}
