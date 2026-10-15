import { spawn } from "node:child_process";

// The child inherits the helper's account and session; WTS notifications are scoped to that session.
const SESSION_WATCHER = String.raw`
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class NoctisSessionWindow : NativeWindow {
  [DllImport("wtsapi32.dll")] static extern bool WTSRegisterSessionNotification(IntPtr hWnd, int flags);
  [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr hWnd);
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  readonly int session = Process.GetCurrentProcess().SessionId;
  bool? previous;
  readonly Timer timer = new Timer();
  public NoctisSessionWindow() {
    CreateHandle(new CreateParams { Parent = new IntPtr(-3) });
    if (session <= 0 || !WTSRegisterSessionNotification(Handle, 0)) throw new InvalidOperationException("No owner session notifications");
    Publish();
    timer.Interval = 5000;
    timer.Tick += (sender, args) => Publish();
    timer.Start();
  }
  void Publish() {
    bool present = false;
    IntPtr buffer; int bytes;
    if (WTSQuerySessionInformation(IntPtr.Zero, session, 25, out buffer, out bytes)) {
      try {
        // WTSINFOEX: Level, aligned LEVEL1 data (session id, connection state, lock flags).
        present = bytes >= 20 && Marshal.ReadInt32(buffer, 0) == 1 && Marshal.ReadInt32(buffer, 8) == session && Marshal.ReadInt32(buffer, 12) == 0 && Marshal.ReadInt32(buffer, 16) == 1;
      } finally { WTSFreeMemory(buffer); }
    }
    if (previous != present) { previous = present; Console.WriteLine(present ? "true" : "false"); Console.Out.Flush(); }
  }
  protected override void WndProc(ref Message message) {
    if (message.Msg == 0x02B1 && message.LParam.ToInt32() == session) Publish();
    base.WndProc(ref message);
  }
  public void Stop() { timer.Stop(); WTSUnRegisterSessionNotification(Handle); DestroyHandle(); }
}
'@
$window = New-Object NoctisSessionWindow
try { [System.Windows.Forms.Application]::Run() } finally { $window.Stop() }
`;

export function watchWindowsOwnerPresence(onPresence: (present: boolean) => void): () => void {
  onPresence(false);
  if (process.platform !== "win32") return () => undefined;
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(SESSION_WATCHER, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    if (pending.length > 128) {
      pending = "";
      onPresence(false);
    }
    for (const line of lines) {
      if (line === "true" || line === "false") onPresence(line === "true");
    }
  });
  child.on("error", () => onPresence(false));
  child.on("close", () => onPresence(false));
  return () => {
    child.kill();
    onPresence(false);
  };
}
