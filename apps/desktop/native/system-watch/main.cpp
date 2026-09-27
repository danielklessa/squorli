// squorli-system-watch: tells the desktop app what the client cannot see from inside its window.
//
//   input        a game controller was used (any XInput controller, any HID joystick, gamepad or multi-axis controller),
//                at most once a second. Chromium's Gamepad API only delivers while the app's window has the focus, and
//                Windows does not count controllers as user input, so somebody who plays with a controller and only listens
//                looked absent (docs/features/afk.md, 20 September 2026).
//   display 1|0  whether some program asks Windows to keep the display on (ES_DISPLAY_REQUIRED), which browsers and players
//                do while a video plays; once at the start and on every change.
//   game <path>  the program of the watch list whose window is the topmost one (its executable's full path, UTF-8), which is
//                the one used last; `game` alone = none has a window any more. Game detection (docs/features/games.md):
//                the app names the folders of the installed games and the programs the user added, and only what lies in
//                them is ever reported. A program counts while it has a visible window of its own (minimized too), so a
//                game started before the app is found, and a service that merely runs in the background is not.
//
//   key <hex> 1|0 a watched key was pressed (1) or released (0): its scan code (set 1 make code, 0x100 added for an E0
//                prefix), as the app named it. The push-to-talk key across the system (docs/features/hotkeys.md, 22
//                September 2026): a global shortcut has no key-up and takes the key from every program, this watch has
//                both and takes it from nobody. Only the named keys are ever reported, and the keyboard is only listened
//                to (Raw Input, INPUTSINK) while at least one key is named; a held key is reported once.
//
//   window<TAB><request><TAB><hwnd><TAB><tool 0|1><TAB><class><TAB><path><TAB><fullscreen 0|1>
//                the answer to "windows": one line per window asked for that exists (its window class, whether it is a tool
//                window, which the task bar and Alt+Tab leave out, its program's full path, empty when the process does
//                not say, and whether it covers its whole monitor without being maximized: a game or a player in full
//                screen), then one line "windows<TAB><request>". The screen share's picker leaves desktop widgets out with
//                it and knows which window is a game's (docs/features/voice-video.md, 21 September 2026).
//
//   busy<TAB><request><TAB><state><TAB><fullscreen 0|1>
//                the answer to "busy": Windows' own notification state (SHQueryUserNotificationState: 1 = not present,
//                2 = busy with a full screen application, 3 = a Direct3D game in exclusive full screen, 4 = presentation
//                mode, 5 = accepts notifications, 6 = quiet time, 7 = an app of the Store in full screen; 0 = unknown) and
//                whether the foreground window covers its whole monitor (a game in borderless full screen, which Windows
//                does not always count). The app asks before a notification (docs/features/notifications.md, 27 September 2026).
//
// stdin:  one line "watch<TAB><path><TAB><path>..." replaces the watch list (UTF-8; a path ending in a backslash is a folder
//         with everything below it, any other is one executable; "watch" alone = nothing is watched, which is the start).
//         One line "windows<TAB><request><TAB><hwnd><TAB><hwnd>..." (decimal window handles) asks about those windows.
//         One line "keys<TAB><hex><TAB><hex>..." replaces the watched keys ("keys" alone = none, which is the start).
//         One line "busy<TAB><request>" asks whether something runs in full screen.
// stdout: the lines above, after one line "ready". The helper ends when stdin closes (the parent is gone) or when it is killed.
// Windows only. It reads no mouse and no window contents, and of the keyboard only the keys the app names, while it names them.
#include <windows.h>
#include <winternl.h>
#include <xinput.h>
#include <powrprof.h>
#include <hidsdi.h>
#include <shellapi.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <io.h>
#include <atomic>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

// The stdin thread tells the main thread with this message that the watched keys changed (Raw Input is registered there).
constexpr UINT WM_KEYS_CHANGED = WM_APP + 1;
HWND mainWindow = nullptr;

// Only a real step counts: sticks drift, sensors flicker, some controllers report all the time. The comparison is with the
// state at the last counted input, so a lever that stays where it was put (a joystick's throttle) is no input either.
constexpr double AXIS_STEP = 0.1;     // of an axis' whole range (a fifth of the way from the centre to an end)
constexpr int TRIGGER_STEP = 128;     // XInput triggers, 0..255
constexpr int THUMB_STEP = 6554;      // XInput sticks, -32768..32767
constexpr UINT POLL_MS = 250;         // a short press must not fall between two polls
constexpr int PROBE_EVERY = 12;       // empty XInput slots are slow to ask: every 3 s
constexpr int DISPLAY_EVERY = 8;      // every 2 s
constexpr int GAMES_EVERY = 4;        // every second
constexpr int FORGET_EVERY = 240;     // what is known about processes is asked again every minute (process ids are reused)
constexpr ULONGLONG INPUT_LINE_MS = 1000;

ULONGLONG lastInputLine = 0;
void reportInput() {
  const ULONGLONG now = GetTickCount64();
  if (lastInputLine != 0 && now - lastInputLine < INPUT_LINE_MS) return;
  lastInputLine = now;
  if (puts("input") < 0 || fflush(stdout) != 0) ExitProcess(0);  // the reader is gone
}

// --- XInput -----------------------------------------------------------------------------------------------------------
struct PadRef { bool connected = false; bool known = false; XINPUT_GAMEPAD pad = {}; };
PadRef pads[XUSER_MAX_COUNT];

bool stepped(const XINPUT_GAMEPAD& a, const XINPUT_GAMEPAD& b) {
  return a.wButtons != b.wButtons || std::abs(a.bLeftTrigger - b.bLeftTrigger) >= TRIGGER_STEP || std::abs(a.bRightTrigger - b.bRightTrigger) >= TRIGGER_STEP ||
    std::abs(a.sThumbLX - b.sThumbLX) >= THUMB_STEP || std::abs(a.sThumbLY - b.sThumbLY) >= THUMB_STEP || std::abs(a.sThumbRX - b.sThumbRX) >= THUMB_STEP || std::abs(a.sThumbRY - b.sThumbRY) >= THUMB_STEP;
}

void pollXInput(bool probe) {
  for (DWORD i = 0; i < XUSER_MAX_COUNT; i++) {
    PadRef& ref = pads[i];
    if (!ref.connected && !probe) continue;
    XINPUT_STATE state = {};
    if (XInputGetState(i, &state) != ERROR_SUCCESS) { ref = PadRef{}; continue; }
    ref.connected = true;
    if (!ref.known) { ref.known = true; ref.pad = state.Gamepad; continue; }  // first sight: the reference only
    if (!stepped(ref.pad, state.Gamepad)) continue;
    ref.pad = state.Gamepad;
    reportInput();
  }
}

// --- HID joysticks and gamepads through Raw Input -----------------------------------------------------------------------
struct ReportRef { std::vector<USAGE_AND_PAGE> buttons; std::vector<double> values; std::vector<ULONG> hats; };
struct ValueSlot { HIDP_VALUE_CAPS caps; USAGE usage; };
struct HidDevice {
  bool usable = false;
  std::vector<BYTE> preparsed;
  std::vector<ValueSlot> slots;
  ULONG maxButtons = 0;
  std::map<BYTE, ReportRef> refs;  // per report id: a device may split its state over several reports
};
std::map<HANDLE, HidDevice> devices;

HidDevice& deviceOf(HANDLE handle) {
  auto found = devices.find(handle);
  if (found != devices.end()) return found->second;
  HidDevice& device = devices[handle];
  UINT size = 0;
  if (GetRawInputDeviceInfoW(handle, RIDI_PREPARSEDDATA, nullptr, &size) != 0 || size == 0) return device;
  device.preparsed.resize(size);
  if (GetRawInputDeviceInfoW(handle, RIDI_PREPARSEDDATA, device.preparsed.data(), &size) == static_cast<UINT>(-1)) return device;
  const auto data = reinterpret_cast<PHIDP_PREPARSED_DATA>(device.preparsed.data());
  HIDP_CAPS caps = {};
  if (HidP_GetCaps(data, &caps) != HIDP_STATUS_SUCCESS) return device;
  std::vector<HIDP_VALUE_CAPS> values(caps.NumberInputValueCaps);
  USHORT count = caps.NumberInputValueCaps;
  if (count > 0 && HidP_GetValueCaps(HidP_Input, values.data(), &count, data) != HIDP_STATUS_SUCCESS) count = 0;
  for (USHORT i = 0; i < count; i++) {
    const HIDP_VALUE_CAPS& v = values[i];
    if (v.UsagePage >= 0xFF00) continue;  // vendor defined: motion sensors and the like, never still
    const USAGE first = v.IsRange ? v.Range.UsageMin : v.NotRange.Usage;
    const USAGE last = v.IsRange ? v.Range.UsageMax : v.NotRange.Usage;
    for (USAGE usage = first; usage <= last && device.slots.size() < 64; usage++) { device.slots.push_back({ v, usage }); if (usage == 0xFFFF) break; }
  }
  device.maxButtons = HidP_MaxUsageListLength(HidP_Input, 0, data);
  device.usable = true;
  return device;
}

void readReport(HidDevice& device, BYTE* report, ULONG length) {
  const auto data = reinterpret_cast<PHIDP_PREPARSED_DATA>(device.preparsed.data());
  ReportRef now;
  now.buttons.resize(device.maxButtons);
  ULONG pressed = device.maxButtons;
  if (device.maxButtons == 0 || HidP_GetUsagesEx(HidP_Input, 0, now.buttons.data(), &pressed, data, reinterpret_cast<PCHAR>(report), length) != HIDP_STATUS_SUCCESS) pressed = 0;
  now.buttons.resize(pressed);
  std::sort(now.buttons.begin(), now.buttons.end(), [](const USAGE_AND_PAGE& a, const USAGE_AND_PAGE& b) { return a.UsagePage != b.UsagePage ? a.UsagePage < b.UsagePage : a.Usage < b.Usage; });

  bool any = pressed > 0;
  for (const ValueSlot& slot : device.slots) {
    ULONG raw = 0;
    const bool hat = slot.caps.UsagePage == 0x01 && slot.usage == 0x39;
    // A value of another report: NaN keeps its place in the list and never compares as a step.
    if (HidP_GetUsageValue(HidP_Input, slot.caps.UsagePage, slot.caps.LinkCollection, slot.usage, &raw, data, reinterpret_cast<PCHAR>(report), length) != HIDP_STATUS_SUCCESS) { if (hat) now.hats.push_back(ULONG_MAX); else now.values.push_back(NAN); continue; }
    any = true;
    if (hat) { now.hats.push_back(raw); continue; }  // a hat switch has eight places: every change counts
    double value = raw, low = slot.caps.LogicalMin, high = slot.caps.LogicalMax;
    const USHORT bits = slot.caps.BitSize;
    if (slot.caps.LogicalMin < 0 && bits > 0 && bits < 32 && (raw & (1ul << (bits - 1)))) value = static_cast<double>(static_cast<LONG>(raw | (~0ul << bits)));
    if (high <= low) { low = 0; high = std::pow(2.0, bits) - 1; }
    now.values.push_back(high > low ? (value - low) / (high - low) : 0);
  }
  if (!any) return;  // a report this description does not explain (a controller in its maker's own mode)

  auto found = device.refs.find(report[0]);
  if (found == device.refs.end()) { device.refs[report[0]] = std::move(now); return; }  // first sight: the reference only
  ReportRef& ref = found->second;
  bool step = ref.buttons.size() != now.buttons.size() || ref.hats != now.hats;
  for (size_t i = 0; !step && i < now.buttons.size(); i++) step = ref.buttons[i].Usage != now.buttons[i].Usage || ref.buttons[i].UsagePage != now.buttons[i].UsagePage;
  for (size_t i = 0; !step && i < now.values.size() && i < ref.values.size(); i++) step = std::fabs(now.values[i] - ref.values[i]) >= AXIS_STEP;
  if (!step) return;
  ref = std::move(now);
  reportInput();
}

// --- the watched keys (push-to-talk across the system) ---------------------------------------------------------------------
std::mutex keysMutex;
std::set<unsigned> watchedKeys;      // scan codes with 0x100 for E0, as the app named them
bool keyboardRegistered = false;
std::map<unsigned, bool> keyDown;    // what was last reported per watched key: a held key repeats its make code

void reportKey(unsigned scan, bool down) {
  if (printf("key %x %d\n", scan, down ? 1 : 0) < 0 || fflush(stdout) != 0) ExitProcess(0);
}

// Runs on the main thread (WM_KEYS_CHANGED): the keyboard is only listened to while a key is named. RIDEV_REMOVE needs a
// null target window.
void applyKeys() {
  bool any = false;
  { std::lock_guard<std::mutex> lock(keysMutex); any = !watchedKeys.empty(); }
  if (any == keyboardRegistered) return;
  RAWINPUTDEVICE keyboard = {};
  keyboard.usUsagePage = 0x01;
  keyboard.usUsage = 0x06;
  keyboard.dwFlags = any ? RIDEV_INPUTSINK : RIDEV_REMOVE;
  keyboard.hwndTarget = any ? mainWindow : nullptr;
  if (RegisterRawInputDevices(&keyboard, 1, sizeof(RAWINPUTDEVICE))) keyboardRegistered = any;
  else fprintf(stderr, "warning: RegisterRawInputDevices keyboard failed (%lu)\n", GetLastError());
  // Whatever was down when the watch changed is up as far as the app is concerned (it releases push-to-talk itself).
  keyDown.clear();
}

void onKeyboard(const RAWKEYBOARD& kb) {
  USHORT make = kb.MakeCode;
  bool e0 = (kb.Flags & RI_KEY_E0) != 0;
  // Input made by a program (SendInput without a scan code: some macro tools) names the virtual key only.
  if (make == 0 || make == KEYBOARD_OVERRUN_MAKE_CODE) {
    const UINT sc = MapVirtualKeyW(kb.VKey, MAPVK_VK_TO_VSC_EX);
    if (sc == 0) return;
    make = static_cast<USHORT>(sc & 0xFF);
    e0 = ((sc >> 8) & 0xFF) == 0xE0;
  }
  if (kb.Flags & RI_KEY_E1) return;  // Pause: not a key the app names
  const unsigned scan = static_cast<unsigned>(make & 0xFF) | (e0 ? 0x100u : 0u);
  { std::lock_guard<std::mutex> lock(keysMutex); if (watchedKeys.find(scan) == watchedKeys.end()) return; }
  const bool down = (kb.Flags & RI_KEY_BREAK) == 0;
  auto known = keyDown.find(scan);
  if (known != keyDown.end() && known->second == down) return;  // a held key repeats
  keyDown[scan] = down;
  reportKey(scan, down);
}

void onRawInput(HRAWINPUT handle) {
  UINT size = 0;
  if (GetRawInputData(handle, RID_INPUT, nullptr, &size, sizeof(RAWINPUTHEADER)) != 0 || size == 0) return;
  std::vector<BYTE> buffer(size);
  if (GetRawInputData(handle, RID_INPUT, buffer.data(), &size, sizeof(RAWINPUTHEADER)) != size) return;
  RAWINPUT* input = reinterpret_cast<RAWINPUT*>(buffer.data());
  if (input->header.dwType == RIM_TYPEKEYBOARD) { if (keyboardRegistered) onKeyboard(input->data.keyboard); return; }
  if (input->header.dwType != RIM_TYPEHID || input->header.hDevice == nullptr) return;
  HidDevice& device = deviceOf(input->header.hDevice);
  if (!device.usable) return;
  const RAWHID& hid = input->data.hid;
  for (DWORD i = 0; i < hid.dwCount; i++) readReport(device, const_cast<BYTE*>(hid.bRawData) + static_cast<size_t>(i) * hid.dwSizeHid, hid.dwSizeHid);
}

// --- display required ---------------------------------------------------------------------------------------------------
int lastDisplay = -1;
void pollDisplay() {
  ULONG state = 0;
  if (CallNtPowerInformation(SystemExecutionState, nullptr, 0, &state, sizeof(state)) != 0) return;
  const int required = (state & ES_DISPLAY_REQUIRED) ? 1 : 0;
  if (required == lastDisplay) return;
  lastDisplay = required;
  if (printf("display %d\n", required) < 0 || fflush(stdout) != 0) ExitProcess(0);
}

// --- the watched programs (game display) ---------------------------------------------------------------------------------
std::mutex watchMutex;
std::vector<std::wstring> watchFolders, watchFiles;  // lower case
std::atomic<bool> watchChanged{false};

std::wstring lowered(std::wstring text) { if (!text.empty()) CharLowerBuffW(text.data(), static_cast<DWORD>(text.size())); return text; }
std::wstring wide(const std::string& utf8) {
  if (utf8.empty()) return L"";
  const int length = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring text(static_cast<size_t>(length > 0 ? length : 0), L'\0');
  if (length > 0) MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), text.data(), length);
  return text;
}
std::string utf8(const std::wstring& text) {
  if (text.empty()) return "";
  const int length = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string bytes(static_cast<size_t>(length > 0 ? length : 0), '\0');
  if (length > 0) WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), bytes.data(), length, nullptr, nullptr);
  return bytes;
}

std::vector<std::string> fields(const std::string& line) {
  std::vector<std::string> parts;
  size_t from = 0;
  for (;;) {
    const size_t to = line.find('\t', from);
    parts.push_back(line.substr(from, to == std::string::npos ? std::string::npos : to - from));
    if (to == std::string::npos) return parts;
    from = to + 1;
  }
}

std::wstring pathOfProcess(DWORD pid) {
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return L"";
  std::vector<wchar_t> buffer(32768);
  DWORD length = static_cast<DWORD>(buffer.size());
  const bool ok = QueryFullProcessImageNameW(process, 0, buffer.data(), &length) != 0;
  CloseHandle(process);
  return ok ? std::wstring(buffer.data(), length) : L"";
}

// Runs on the thread that reads stdin. The whole answer is one write, so it never mixes with a line of the main thread.
void describeWindows(const std::vector<std::string>& parts) {
  if (parts.size() < 2 || parts[1].empty() || parts[1].size() > 20 || parts[1].find_first_not_of("0123456789") != std::string::npos) return;
  std::string answer;
  for (size_t i = 2; i < parts.size() && i < 1026; i++) {
    const std::string& id = parts[i];
    if (id.empty() || id.size() > 20 || id.find_first_not_of("0123456789") != std::string::npos) continue;
    const HWND window = reinterpret_cast<HWND>(static_cast<UINT_PTR>(strtoull(id.c_str(), nullptr, 10)));
    if (!IsWindow(window)) continue;
    wchar_t name[257] = {};
    const int length = GetClassNameW(window, name, 257);
    std::wstring className(name, static_cast<size_t>(length > 0 ? length : 0));
    for (wchar_t& c : className) if (c == L'\t' || c == L'\n' || c == L'\r') c = L' ';
    const LONG_PTR style = GetWindowLongPtrW(window, GWL_EXSTYLE);
    const bool tool = (style & WS_EX_TOOLWINDOW) != 0 && (style & WS_EX_APPWINDOW) == 0;
    // Full screen = the window covers its monitor. A maximized window does too while the task bar hides itself, so it does not count.
    bool fullscreen = false;
    RECT rect = {};
    MONITORINFO monitor = {};
    monitor.cbSize = sizeof(monitor);
    if (!IsZoomed(window) && !IsIconic(window) && GetWindowRect(window, &rect) && GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor))
      fullscreen = rect.left <= monitor.rcMonitor.left && rect.top <= monitor.rcMonitor.top && rect.right >= monitor.rcMonitor.right && rect.bottom >= monitor.rcMonitor.bottom;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    answer += "window\t" + parts[1] + "\t" + id + "\t" + (tool ? "1" : "0") + "\t" + utf8(className) + "\t" + utf8(pid != 0 ? pathOfProcess(pid) : L"") + "\t" + (fullscreen ? "1" : "0") + "\n";
  }
  answer += "windows\t" + parts[1] + "\n";
  if (fwrite(answer.data(), 1, answer.size(), stdout) != answer.size() || fflush(stdout) != 0) ExitProcess(0);
}

// Runs on the thread that reads stdin; one write, like describeWindows.
void describeBusy(const std::vector<std::string>& parts) {
  if (parts.size() < 2 || parts[1].empty() || parts[1].size() > 20 || parts[1].find_first_not_of("0123456789") != std::string::npos) return;
  QUERY_USER_NOTIFICATION_STATE state = static_cast<QUERY_USER_NOTIFICATION_STATE>(0);
  if (FAILED(SHQueryUserNotificationState(&state))) state = static_cast<QUERY_USER_NOTIFICATION_STATE>(0);
  bool fullscreen = false;
  const HWND window = GetForegroundWindow();
  wchar_t name[64] = {};
  if (window && GetClassNameW(window, name, 64) > 0 && wcscmp(name, L"Progman") != 0 && wcscmp(name, L"WorkerW") != 0 && wcscmp(name, L"Shell_TrayWnd") != 0) {
    RECT rect = {};
    MONITORINFO monitor = {};
    monitor.cbSize = sizeof(monitor);
    if (!IsIconic(window) && GetWindowRect(window, &rect) && GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor))
      fullscreen = rect.left <= monitor.rcMonitor.left && rect.top <= monitor.rcMonitor.top && rect.right >= monitor.rcMonitor.right && rect.bottom >= monitor.rcMonitor.bottom;
  }
  const std::string answer = "busy\t" + parts[1] + "\t" + std::to_string(static_cast<int>(state)) + "\t" + (fullscreen ? "1" : "0") + "\n";
  if (fwrite(answer.data(), 1, answer.size(), stdout) != answer.size() || fflush(stdout) != 0) ExitProcess(0);
}

// Runs on the stdin thread: the set changes here, the registration follows on the main thread.
void setKeys(const std::vector<std::string>& parts) {
  std::set<unsigned> keys;
  for (size_t i = 1; i < parts.size() && i < 65; i++) {
    const std::string& hex = parts[i];
    if (hex.empty() || hex.size() > 4 || hex.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) continue;
    const unsigned scan = static_cast<unsigned>(strtoul(hex.c_str(), nullptr, 16));
    if ((scan & 0xFF) != 0 && scan <= 0x1FF) keys.insert(scan);
  }
  { std::lock_guard<std::mutex> lock(keysMutex); watchedKeys = std::move(keys); }
  if (mainWindow) PostMessageW(mainWindow, WM_KEYS_CHANGED, 0, 0);
}

void onCommand(const std::string& line) {
  if (line.rfind("windows\t", 0) == 0) { describeWindows(fields(line)); return; }
  if (line.rfind("busy\t", 0) == 0) { describeBusy(fields(line)); return; }
  if (line == "keys" || line.rfind("keys\t", 0) == 0) { setKeys(fields(line)); return; }
  if (line.rfind("watch", 0) != 0 || (line.size() > 5 && line[5] != '\t')) return;
  std::vector<std::wstring> folders, files;
  size_t from = 5;
  while (from < line.size()) {
    const size_t to = line.find('\t', from + 1);
    const std::wstring path = lowered(wide(line.substr(from + 1, (to == std::string::npos ? line.size() : to) - from - 1)));
    if (path.size() >= 4) (path.back() == L'\\' ? folders : files).push_back(path);  // nothing as short as a drive's root
    from = to == std::string::npos ? line.size() : to;
  }
  std::lock_guard<std::mutex> lock(watchMutex);
  watchFolders = std::move(folders);
  watchFiles = std::move(files);
  watchChanged = true;
}

bool watched(const std::wstring& path) {
  const std::wstring lower = lowered(path);
  std::lock_guard<std::mutex> lock(watchMutex);
  for (const std::wstring& file : watchFiles) if (lower == file) return true;
  for (const std::wstring& folder : watchFolders) if (lower.size() > folder.size() && lower.compare(0, folder.size(), folder) == 0) return true;
  return false;
}

// What is known about a process: asked once, not at every look at its windows.
struct KnownProcess { bool isWatched; std::wstring path; };
std::map<DWORD, KnownProcess> knownProcesses;
std::wstring currentGamePath;

void reportGame(const std::wstring& path) {
  const std::string line = path.empty() ? "game\n" : "game " + utf8(path) + "\n";
  if (fwrite(line.data(), 1, line.size(), stdout) != line.size() || fflush(stdout) != 0) ExitProcess(0);
}

const KnownProcess& processOf(DWORD pid) {
  auto found = knownProcesses.find(pid);
  if (found != knownProcesses.end()) return found->second;
  KnownProcess& known = knownProcesses[pid];
  known.isWatched = false;
  // A process that does not let itself be asked (protected, another user's) simply is no game.
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return known;
  wchar_t buffer[32768];
  DWORD length = static_cast<DWORD>(sizeof(buffer) / sizeof(buffer[0]));
  if (QueryFullProcessImageNameW(process, 0, buffer, &length)) { known.path.assign(buffer, length); known.isWatched = watched(known.path); }
  CloseHandle(process);
  return known;
}

// Top-level windows come from the top of the z-order down: the first one of a watched program is the game used last.
BOOL CALLBACK onWindow(HWND window, LPARAM found) {
  if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER) != nullptr || (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW)) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == 0) return TRUE;
  const KnownProcess& known = processOf(pid);
  if (!known.isWatched) return TRUE;
  *reinterpret_cast<std::wstring*>(found) = known.path;
  return FALSE;
}

void pollGames(bool forget) {
  if (watchChanged.exchange(false) || forget) knownProcesses.clear();
  std::wstring found;
  bool watching = false;
  { std::lock_guard<std::mutex> lock(watchMutex); watching = !watchFolders.empty() || !watchFiles.empty(); }
  if (watching) EnumWindows(onWindow, reinterpret_cast<LPARAM>(&found));
  if (lowered(found) == lowered(currentGamePath)) return;
  currentGamePath = found;
  reportGame(found);
}

int ticks = 0;
LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_INPUT:
      onRawInput(reinterpret_cast<HRAWINPUT>(lParam));
      break;  // DefWindowProc cleans the input up
    case WM_INPUT_DEVICE_CHANGE:
      if (wParam == GIDC_REMOVAL) devices.erase(reinterpret_cast<HANDLE>(lParam));
      return 0;
    case WM_KEYS_CHANGED:
      applyKeys();
      return 0;
    case WM_TIMER:
      pollXInput(ticks % PROBE_EVERY == 0);
      if (ticks % DISPLAY_EVERY == 0) pollDisplay();
      if (ticks % GAMES_EVERY == 0) pollGames(ticks % FORGET_EVERY == 0);
      ticks++;
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

}  // namespace

int main() {
  WNDCLASSW windowClass = {};
  windowClass.lpfnWndProc = windowProc;
  windowClass.hInstance = GetModuleHandleW(nullptr);
  windowClass.lpszClassName = L"SquorliSystemWatch";
  if (!RegisterClassW(&windowClass)) { fprintf(stderr, "error: RegisterClass\n"); return 1; }
  HWND window = CreateWindowExW(0, windowClass.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, windowClass.hInstance, nullptr);
  if (!window) { fprintf(stderr, "error: CreateWindow\n"); return 1; }
  mainWindow = window;

  // Generic desktop page: joystick, gamepad, multi-axis controller. INPUTSINK = also while another window has the focus.
  // The keyboard is registered separately and only while the app names keys (applyKeys).
  RAWINPUTDEVICE wanted[3] = {};
  const USHORT usages[3] = { 0x04, 0x05, 0x08 };
  for (int i = 0; i < 3; i++) { wanted[i].usUsagePage = 0x01; wanted[i].usUsage = usages[i]; wanted[i].dwFlags = RIDEV_INPUTSINK | RIDEV_DEVNOTIFY; wanted[i].hwndTarget = window; }
  // Without Raw Input the XInput controllers and the display state still work.
  if (!RegisterRawInputDevices(wanted, 3, sizeof(RAWINPUTDEVICE))) fprintf(stderr, "warning: RegisterRawInputDevices failed (%lu)\n", GetLastError());

  // The parent holds our stdin open and sends the watch list through it; when it goes away (also when it crashes), reading
  // ends and so do we.
  _setmode(_fileno(stdin), _O_BINARY);
  std::thread([] {
    std::string pending;
    char byte = 0;
    for (;;) {
      if (fread(&byte, 1, 1, stdin) == 0) ExitProcess(0);  // byte by byte: a pipe's fread would wait for a full buffer
      if (byte == '\n') { if (!pending.empty() && pending.back() == '\r') pending.pop_back(); onCommand(pending); pending.clear(); }
      else if (pending.size() < (1u << 20)) pending.push_back(byte);
    }
  }).detach();

  puts("ready");
  fflush(stdout);
  SetTimer(window, 1, POLL_MS, nullptr);
  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
  return 0;
}
