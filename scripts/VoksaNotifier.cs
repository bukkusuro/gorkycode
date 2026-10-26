using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Toolkit.Uwp.Notifications;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

[assembly: System.Reflection.AssemblyTitle("ВОКСА")]
[assembly: System.Reflection.AssemblyProduct("ВОКСА")]
public sealed class ReminderItem {
  public string key;
  public string xml;
  public long at;
  public long expires;
}
public sealed class ReminderRequest {
  public string owner;
  public ReminderItem[] items;
}
public static class VoksaNotifier {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8388608 };
  static readonly ManualResetEvent Activated = new ManualResetEvent(false);
  static string Root { get { return Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..")); } }
  static string Tag(string owner, string key) {
    using (var hash = SHA256.Create())
      return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(owner + ":" + key))).Replace("-", "").Substring(0, 16);
  }
  static DateTimeOffset Instant(long value) {
    return new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero).AddMilliseconds(value);
  }
  static void OpenSite(string argument) {
    var id = argument.StartsWith("entry=", StringComparison.Ordinal) ? Uri.UnescapeDataString(argument.Substring(6)) : "";
    if (!Regex.IsMatch(id, @"^[\w@.-]{0,200}$")) id = "";
    var url = "http://localhost:5173/VoiceTask/";
    try {
      var request = WebRequest.Create(url);
      request.Timeout = 2000;
      using (request.GetResponse()) { }
    } catch {
      var start = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(Root, "start-local.ps1") + "\" -NoBrowser") {
        UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
      };
      using (var process = Process.Start(start)) process.WaitForExit(20000);
    }
    Process.Start(new ProcessStartInfo(url + (id.Length > 0 ? "?entry=" + Uri.EscapeDataString(id) : "")) { UseShellExecute = true });
  }
  public static void Main(string[] args) {
    var output = args.Length > 2 ? args[2] : null;
    try {
      ToastNotificationManagerCompat.OnActivated += e => {
        try { OpenSite(e.Argument); } finally { Activated.Set(); }
      };
      if (args.Contains("-ToastActivated")) { Activated.WaitOne(20000); return; }
      if (args.Length == 0) { OpenSite(""); return; }
      var request = Json.Deserialize<ReminderRequest>(File.ReadAllText(args[1], Encoding.UTF8));
      if (request == null || !Regex.IsMatch(request.owner ?? "", "^[a-f0-9]{16}$")) throw new ArgumentException("Invalid owner");
      var notifier = ToastNotificationManagerCompat.CreateToastNotifier();
      var scheduled = notifier.GetScheduledToastNotifications().ToList();
      var own = scheduled.Where(n => n.Group == request.owner).ToList();
      if (args[0] == "sync") {
        if (notifier.Setting != NotificationSetting.Enabled) throw new InvalidOperationException("Windows notifications are disabled");
        var items = request.items ?? new ReminderItem[0];
        if (items.Length + scheduled.Count - own.Count > 4000) throw new InvalidOperationException("Too many scheduled reminders");
        var desired = new Dictionary<string, ScheduledToastNotification>();
        foreach (var item in items) {
          if (item.at <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) continue;
          var xml = new XmlDocument(); xml.LoadXml(item.xml);
          var tag = Tag(request.owner, item.key);
          var toast = new ScheduledToastNotification(xml, Instant(item.at)) { Tag = tag, Group = request.owner, ExpirationTime = Instant(item.expires) };
          desired[tag] = toast;
        }
        foreach (var old in own) {
          ScheduledToastNotification replacement;
          if (desired.TryGetValue(old.Tag, out replacement) &&
              Math.Abs((old.DeliveryTime - replacement.DeliveryTime).TotalMilliseconds) < 100 &&
              old.Content.GetXml() == replacement.Content.GetXml()) desired.Remove(old.Tag);
          else notifier.RemoveFromSchedule(old);
        }
        foreach (var toast in desired.Values) notifier.AddToSchedule(toast);
      } else if (args[0] == "clear") {
        foreach (var toast in own) notifier.RemoveFromSchedule(toast);
        ToastNotificationManagerCompat.History.RemoveGroup(request.owner);
      } else if (args[0] != "status" && args[0] != "history") throw new ArgumentException("Invalid command");
      var response = new Dictionary<string, object> {
        { "ok", true }, { "setting", notifier.Setting.ToString() },
        { "scheduled", notifier.GetScheduledToastNotifications().Count(n => n.Group == request.owner) },
        { "delivered", ToastNotificationManagerCompat.History.GetHistory().Count(n => n.Group == request.owner) }
      };
      if (output != null) File.WriteAllText(output, Json.Serialize(response), new UTF8Encoding(false));
    } catch (Exception error) {
      if (output != null) File.WriteAllText(output, Json.Serialize(new { ok = false, error = error.Message, code = error.HResult }), new UTF8Encoding(false));
      Environment.ExitCode = 1;
    }
  }
}
