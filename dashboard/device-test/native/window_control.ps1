param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("get", "set", "maximize", "restore")]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$Binary,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 0,
    [int]$Height = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class DeviceWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr handle, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(
        IntPtr handle,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr handle, int command);
}
"@

$resolvedBinary = [IO.Path]::GetFullPath($Binary)
$matches = @(
    Get-Process -Name "Time" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                [IO.Path]::GetFullPath($_.Path) -eq $resolvedBinary
            }
            catch {
                $false
            }
        }
)

if ($matches.Count -ne 1) {
    throw "Expected one isolated debug Time process at $resolvedBinary; found $($matches.Count)."
}

$handle = $matches[0].MainWindowHandle
if ($handle -eq [IntPtr]::Zero) {
    throw "The isolated debug Time process does not have a visible window."
}

switch ($Action) {
    "set" {
        if ($Width -le 0 -or $Height -le 0) {
            throw "Set requires positive width and height."
        }
        if (-not [DeviceWindow]::SetWindowPos(
            $handle,
            [IntPtr]::Zero,
            $X,
            $Y,
            $Width,
            $Height,
            0x0040
        )) {
            throw "SetWindowPos failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
        }
    }
    "maximize" {
        # ShowWindow returns the previous visibility state, so false is valid
        # for a first transition from a non-visible state.
        [void][DeviceWindow]::ShowWindow($handle, 3)
    }
    "restore" {
        [void][DeviceWindow]::ShowWindow($handle, 9)
    }
}

$rect = [DeviceWindow+Rect]::new()
if (-not [DeviceWindow]::GetWindowRect($handle, [ref]$rect)) {
    throw "GetWindowRect failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
}

[pscustomobject]@{
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
} | ConvertTo-Json -Compress
