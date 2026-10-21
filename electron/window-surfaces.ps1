param([int]$ExcludeProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CompanionWindowSurfaces {
  public struct Rect { public int Left, Top, Right, Bottom; }
  public class Surface { public string id; public int x, y, width, height; }
  delegate bool Callback(IntPtr handle, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int Frame(IntPtr handle, int attribute, out Rect value, int size);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int Attribute(IntPtr handle, int attribute, out int value, int size);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  public static Surface[] Read(int excluded) {
    var result = new List<Surface>();
    // DWM frame rectangles use physical pixels. Keep this helper per-monitor
    // aware; the Electron owner converts every rectangle to DIP afterwards.
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      EnumWindows(delegate(IntPtr handle, IntPtr unused) {
        uint process; GetWindowThreadProcessId(handle, out process);
        if(process == excluded || !IsWindowVisible(handle) || IsIconic(handle)) return true;
        int cloaked; if(Attribute(handle, 14, out cloaked, 4) != 0 || cloaked != 0) return true;
        var name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
        string cls = name.ToString();
        if(cls == "Progman" || cls == "WorkerW" || cls.StartsWith("Shell_TrayWnd") || cls == "Shell_SecondaryTrayWnd"
           || cls == "tooltips_class32" || cls == "#32768") return true;
        Rect rect; if(Frame(handle, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0) return true;
        if(rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;
        result.Add(new Surface { id=handle.ToInt64().ToString(), x=rect.Left, y=rect.Top,
          width=rect.Right-rect.Left, height=rect.Bottom-rect.Top });
        return true;
      }, IntPtr.Zero);
    } finally { if(previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    return result.ToArray();
  }
}
'@
# One long-lived, hidden helper; EOF from the owner terminates it. No titles,
# content, input hooks or third-party window writes are requested.
while ($null -ne ($requestLine = [Console]::ReadLine())) {
  if ($requestLine -ne 'read') { continue }
  $surfaces = @([CompanionWindowSurfaces]::Read($ExcludeProcessId))
  [Console]::WriteLine((ConvertTo-Json -InputObject $surfaces -Compress))
}
