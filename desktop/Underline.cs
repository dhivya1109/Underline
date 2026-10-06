// Underline for Windows — a tray app. Select text in any app, press Ctrl+Shift+U,
// review it in a small card, and save it to the same Google Sheet the Chrome extension uses.
//
// Built with the C# 5 compiler that ships with Windows (see build.ps1), so keep to C# 5:
// no $"" strings, no ?. operator, no expression-bodied members.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Underline
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            // build.ps1 uses this to check the connection without opening any windows
            if (args.Length == 2 && args[0] == "--ping")
            {
                Result ping = Api.Ping();
                File.WriteAllText(args[1], ping.Message + (Api.LastError != null ? Environment.NewLine + Api.LastError : ""));
                return;
            }

            bool firstInstance;
            using (var mutex = new Mutex(true, "Underline.Desktop.SingleInstance", out firstInstance))
            {
                if (!firstInstance)
                {
                    MessageBox.Show("Underline is already running — look for its icon near the clock.", "Underline");
                    return;
                }
                Native.SetProcessDPIAware();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp());
            }
        }
    }

    // ---------- The tray icon, the hotkey, and grabbing the selection ----------

    class TrayApp : ApplicationContext
    {
        readonly NotifyIcon tray;
        readonly HotkeyWindow hotkey;
        Settings settings;
        EditorForm editor;
        SettingsForm settingsForm;

        public TrayApp()
        {
            settings = Settings.Load();

            var menu = new ContextMenuStrip();
            menu.Items.Add("Add a quote\tCtrl+Shift+U", null, delegate { OpenEditor("", ""); });
            menu.Items.Add("Settings…", null, delegate { OpenSettings(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit Underline", null, delegate { ExitThread(); });

            tray = new NotifyIcon
            {
                Icon = Art.TrayIcon(),
                Text = "Underline — Ctrl+Shift+U to save a quote",
                ContextMenuStrip = menu,
                Visible = true
            };
            tray.MouseClick += delegate(object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) OpenEditor("", "");
            };

            hotkey = new HotkeyWindow();
            hotkey.Pressed += OnHotkey;

            if (!hotkey.Registered)
            {
                tray.ShowBalloonTip(6000, "Underline",
                    "Another app is already using Ctrl+Shift+U, so the shortcut won't work. You can still click this icon to add a quote.",
                    ToolTipIcon.Warning);
            }

            if (settings.Name.Length == 0)
            {
                OpenSettings();
            }
            else
            {
                tray.ShowBalloonTip(4000, "Underline is running",
                    "Select text anywhere and press Ctrl+Shift+U.", ToolTipIcon.None);
            }
        }

        async void OnHotkey()
        {
            IntPtr source = Native.GetForegroundWindow();
            string title = Native.WindowTitle(source);

            // Copy the selection: release Shift (still held from the hotkey) so the app sees Ctrl+C, not Ctrl+Shift+C
            uint before = Native.GetClipboardSequenceNumber();
            Native.SendCopy();

            string text = "";
            for (int i = 0; i < 20; i++)
            {
                await Task.Delay(25);
                if (Native.GetClipboardSequenceNumber() != before)
                {
                    await Task.Delay(30); // let the app finish writing
                    text = ReadClipboard();
                    break;
                }
            }

            OpenEditor(QuoteText.Clean(text), title);
        }

        static string ReadClipboard()
        {
            for (int i = 0; i < 5; i++)
            {
                try { return Clipboard.ContainsText() ? Clipboard.GetText() : ""; }
                catch (ExternalException) { Thread.Sleep(30); } // another app has it open
            }
            return "";
        }

        void OpenEditor(string quote, string sourceTitle)
        {
            if (settings.Name.Length == 0)
            {
                OpenSettings();
                return;
            }
            if (editor != null && !editor.IsDisposed) editor.Close();
            editor = new EditorForm(quote, sourceTitle, settings);
            editor.Show();
            editor.Activate();
        }

        void OpenSettings()
        {
            if (settingsForm != null && !settingsForm.IsDisposed)
            {
                settingsForm.Activate();
                return;
            }
            settingsForm = new SettingsForm(settings);
            settingsForm.FormClosed += delegate { settings = Settings.Load(); };
            settingsForm.Show();
            settingsForm.Activate();
        }

        protected override void ExitThreadCore()
        {
            hotkey.Dispose();
            tray.Visible = false;
            tray.Dispose();
            base.ExitThreadCore();
        }
    }

    class HotkeyWindow : NativeWindow, IDisposable
    {
        const int Id = 1;
        public event Action Pressed;
        public readonly bool Registered;

        public HotkeyWindow()
        {
            CreateHandle(new CreateParams());
            Registered = Native.RegisterHotKey(Handle, Id,
                Native.MOD_CONTROL | Native.MOD_SHIFT | Native.MOD_NOREPEAT, (uint)Keys.U);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY && Pressed != null) Pressed();
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            Native.UnregisterHotKey(Handle, Id);
            DestroyHandle();
        }
    }

    // ---------- Talking to the Apps Script ----------

    class Result
    {
        public string State;   // "success" or "error"
        public string Message;
        public Result(string state, string message) { State = state; Message = message; }
    }

    static class Api
    {
        // Details of the last failure, for the --ping check in build.ps1
        public static string LastError;

        public static Task<Result> Save(Settings settings, string quote, string sourceTitle)
        {
            var payload = new Dictionary<string, object>
            {
                // The owner's admin code publishes straight away; everyone else's quotes wait for review
                { "secret", settings.AdminCode.Length > 0 ? settings.AdminCode : Config.Secret },
                { "quote", quote },
                { "contributor_name", settings.Name },
                { "social_link", settings.LinkedIn },
                { "source_title", sourceTitle },
                { "source_url", "" },
                { "added_at", DateTime.UtcNow.ToString("o") }
            };
            return Task.Run(delegate
            {
                Dictionary<string, object> data;
                string problem = Post(payload, out data);
                if (problem != null) return new Result("error", problem);
                if (data.ContainsKey("ok") && true.Equals(data["ok"]))
                {
                    bool duplicate = data.ContainsKey("duplicate") && true.Equals(data["duplicate"]);
                    bool pending = data.ContainsKey("pending") && true.Equals(data["pending"]);
                    return new Result("success", duplicate ? "Already in the list" : pending ? "Sent for review" : "Underlined");
                }
                return new Result("error", data.ContainsKey("error") ? Convert.ToString(data["error"]) : "Something went wrong");
            });
        }

        // true = it's the admin code, false = it isn't, null = couldn't reach Google
        public static bool? CheckAdminCode(string code)
        {
            Dictionary<string, object> data;
            string problem = Post(new Dictionary<string, object> { { "ping", true }, { "secret", code } }, out data);
            if (problem != null) return null;
            return true.Equals(data.ContainsKey("ok") ? data["ok"] : null) && true.Equals(data.ContainsKey("admin") ? data["admin"] : null);
        }

        public static Result Ping()
        {
            Dictionary<string, object> data;
            string problem = Post(new Dictionary<string, object> { { "ping", true }, { "secret", Config.Secret } }, out data);
            if (problem != null) return new Result("error", problem);
            return true.Equals(data.ContainsKey("ok") ? data["ok"] : null)
                ? new Result("success", "ok")
                : new Result("error", data.ContainsKey("error") ? Convert.ToString(data["error"]) : "not ok");
        }

        // Returns an error message, or null on success with the parsed response in data.
        static string Post(Dictionary<string, object> payload, out Dictionary<string, object> data)
        {
            data = null;
            var json = new JavaScriptSerializer();
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(Config.Endpoint);
                request.Method = "POST";
                // text/plain keeps this a simple request for Apps Script
                request.ContentType = "text/plain;charset=utf-8";
                request.Timeout = 15000;
                // Apps Script saves on the POST, then redirects to googleusercontent.com for the reply.
                // .NET would replay the POST there, so follow the redirect ourselves with a GET.
                request.AllowAutoRedirect = false;

                byte[] body = Encoding.UTF8.GetBytes(json.Serialize(payload));
                using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);

                HttpWebResponse response = (HttpWebResponse)request.GetResponse();
                string location = response.Headers["Location"];
                if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400 && !string.IsNullOrEmpty(location))
                {
                    response.Close();
                    var follow = (HttpWebRequest)WebRequest.Create(location);
                    follow.Timeout = 15000;
                    response = (HttpWebResponse)follow.GetResponse();
                }

                string text;
                using (response)
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    text = reader.ReadToEnd();
                }
                data = json.Deserialize<Dictionary<string, object>>(text);
                return data == null ? "Unexpected reply from Google" : null;
            }
            catch (WebException e)
            {
                LastError = e.ToString();
                return "Couldn't reach Google — check your internet";
            }
            catch (ArgumentException e)
            {
                LastError = e.ToString();
                return "Unexpected reply from Google"; // not JSON, e.g. a sign-in page
            }
        }
    }

    static class QuoteText
    {
        // Same clean-up as the Chrome extension
        public static string Clean(string text)
        {
            text = (text ?? "").Replace("­", "");
            text = Regex.Replace(text, @"\s+", " ").Trim();
            text = Regex.Replace(text, "^[\"“”]+|[\"“”]+$", "");
            return text.Trim();
        }
    }

    // ---------- Settings, stored in %APPDATA%\Underline\settings.txt ----------

    class Settings
    {
        public string Name = "";
        public string LinkedIn = "";
        public string Theme = "auto"; // auto | dark | light
        public string AdminCode = ""; // only on the sheet owner's computer

        static string FolderPath
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Underline"); }
        }

        static string FilePath
        {
            get { return Path.Combine(FolderPath, "settings.txt"); }
        }

        public static Settings Load()
        {
            var s = new Settings();
            if (!File.Exists(FilePath)) return s;
            foreach (string line in File.ReadAllLines(FilePath, Encoding.UTF8))
            {
                int eq = line.IndexOf('=');
                if (eq < 0) continue;
                string key = line.Substring(0, eq);
                string value = line.Substring(eq + 1);
                if (key == "name") s.Name = value;
                else if (key == "linkedin") s.LinkedIn = value;
                else if (key == "theme") s.Theme = value;
                else if (key == "admin") s.AdminCode = value;
            }
            return s;
        }

        public void Save()
        {
            Directory.CreateDirectory(FolderPath);
            File.WriteAllLines(FilePath, new[]
            {
                "name=" + OneLine(Name),
                "linkedin=" + OneLine(LinkedIn),
                "theme=" + OneLine(Theme),
                "admin=" + OneLine(AdminCode)
            }, Encoding.UTF8);
        }

        static string OneLine(string value)
        {
            return Regex.Replace(value ?? "", @"[\r\n]+", " ").Trim();
        }

        public bool Dark
        {
            get
            {
                if (Theme == "dark") return true;
                if (Theme == "light") return false;
                // Follow Windows' app theme
                object light = Registry.GetValue(
                    @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                    "AppsUseLightTheme", 1);
                return light is int && (int)light == 0;
            }
        }

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static bool StartsWithWindows
        {
            get
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    return key != null && key.GetValue("Underline") != null;
                }
            }
            set
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (value) key.SetValue("Underline", "\"" + Application.ExecutablePath + "\"");
                    else key.DeleteValue("Underline", false);
                }
            }
        }
    }

    // ---------- Look and feel (matches the extension's Quiet page theme) ----------

    class Palette
    {
        public Color Card, Field, Fg, Muted, Line, Ok, Err;
        public static readonly Color Accent = Color.FromArgb(0xE5, 0x32, 0x2D);

        public static Palette For(bool dark)
        {
            return dark
                ? new Palette
                {
                    Card = Color.FromArgb(0x1B, 0x1A, 0x18), Field = Color.FromArgb(0x12, 0x11, 0x10),
                    Fg = Color.FromArgb(0xEF, 0xE9, 0xDD), Muted = Color.FromArgb(0x9A, 0x96, 0x8E),
                    Line = Color.FromArgb(0x3A, 0x38, 0x34), Ok = Color.FromArgb(0x9B, 0xE2, 0x9B),
                    Err = Color.FromArgb(0xFF, 0x8A, 0x80)
                }
                : new Palette
                {
                    Card = Color.FromArgb(0xFF, 0xFD, 0xF8), Field = Color.FromArgb(0xF3, 0xEF, 0xE6),
                    Fg = Color.FromArgb(0x14, 0x12, 0x10), Muted = Color.FromArgb(0x7A, 0x76, 0x6F),
                    Line = Color.FromArgb(0xDC, 0xD7, 0xCC), Ok = Color.FromArgb(0x2E, 0x7D, 0x32),
                    Err = Color.FromArgb(0xC6, 0x28, 0x28)
                };
        }
    }

    static class Art
    {
        // "U" with an underline and a red dot, drawn at runtime so there's no icon file to ship
        public static Icon TrayIcon()
        {
            using (var bmp = new Bitmap(32, 32))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                using (var bg = new SolidBrush(Color.FromArgb(0x12, 0x11, 0x10)))
                using (var path = RoundedRect(new Rectangle(0, 0, 31, 31), 7))
                {
                    g.FillPath(bg, path);
                }
                using (var font = new Font("Segoe UI", 15f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var fg = new SolidBrush(Color.FromArgb(0xEF, 0xE9, 0xDD)))
                {
                    var fmt = new StringFormat { Alignment = StringAlignment.Center };
                    g.DrawString("U", font, fg, new RectangleF(0, 3, 30, 22), fmt);
                    g.FillRectangle(fg, 8, 24, 13, 2);
                }
                using (var red = new SolidBrush(Palette.Accent))
                {
                    g.FillEllipse(red, 22, 22, 5, 5);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        public static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    // The "Underline." wordmark: text, an underline in the text colour, and a red dot
    class Wordmark : Control
    {
        const string Word = "Underline";

        // Measured from the font itself so the underline matches the letters exactly
        // and the dot sits on the baseline like a full stop, as on the new tab.
        readonly float textWidth, baseline;

        public Wordmark(Color fg, float px)
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            ForeColor = fg;
            Font = new Font("Segoe UI", px, FontStyle.Bold, GraphicsUnit.Pixel);

            using (var bmp = new Bitmap(1, 1))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                textWidth = g.MeasureString(Word, Font, PointF.Empty, StringFormat.GenericTypographic).Width;
            }
            FontFamily family = Font.FontFamily;
            baseline = px * family.GetCellAscent(FontStyle.Bold) / family.GetEmHeight(FontStyle.Bold);

            Size = new Size((int)Math.Ceiling(textWidth + px * 0.35f), (int)Math.Ceiling(baseline + px * 0.36f));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            float px = Font.Size;

            using (var brush = new SolidBrush(ForeColor))
            {
                g.DrawString(Word, Font, brush, 0, 0, StringFormat.GenericTypographic);
                // Underline: 0.11em thick, 0.2em below the baseline, the width of the word
                g.FillRectangle(brush, 0, baseline + px * 0.2f, textWidth, Math.Max(2f, px * 0.11f));
            }

            // Red dot: 0.2em wide, just after the "e", resting on the baseline
            float dot = Math.Max(3f, px * 0.2f);
            using (var red = new SolidBrush(Palette.Accent))
            {
                g.FillEllipse(red, textWidth + px * 0.07f, baseline - dot, dot, dot);
            }
        }
    }

    // Borderless window with Windows 11 rounded corners and a drop shadow
    class CardForm : Form
    {
        protected readonly Palette P;
        protected readonly float S; // DPI scale

        public CardForm(bool dark)
        {
            P = Palette.For(dark);
            using (Graphics g = CreateGraphics()) S = g.DpiX / 96f;
            FormBorderStyle = FormBorderStyle.None;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = P.Card;
            ForeColor = P.Fg;
            Font = new Font("Segoe UI", 10f);
            ShowInTaskbar = false;
            TopMost = true;
            KeyPreview = true;
            StartPosition = FormStartPosition.Manual;
        }

        protected int Px(float value) { return (int)Math.Round(value * S); }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int round = 2; // DWMWCP_ROUND, Windows 11 only; ignored elsewhere
            Native.DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (var pen = new Pen(P.Line)) e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
        }

        // Let people drag the card by its background
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left)
            {
                Native.ReleaseCapture();
                Native.SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); // WM_NCLBUTTONDOWN, HTCAPTION
            }
        }

        protected Button MakeButton(string text, bool primary)
        {
            var b = new Button
            {
                Text = text,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI Semibold", 9.5f),
                BackColor = primary ? P.Fg : P.Card,
                ForeColor = primary ? P.Card : P.Fg,
                Cursor = Cursors.Hand,
                Size = new Size(Px(76), Px(32)),
                TabStop = true
            };
            b.FlatAppearance.BorderColor = primary ? P.Fg : P.Line;
            b.FlatAppearance.BorderSize = 1;
            return b;
        }

        protected Panel MakeField(Control inner, int height)
        {
            var panel = new Panel { BackColor = P.Field, Padding = new Padding(Px(10), Px(8), Px(10), Px(8)), Height = height };
            panel.Paint += delegate(object s, PaintEventArgs e)
            {
                using (var pen = new Pen(inner.Focused ? P.Muted : P.Line))
                    e.Graphics.DrawRectangle(pen, 0, 0, panel.Width - 1, panel.Height - 1);
            };
            inner.Dock = DockStyle.Fill;
            inner.BackColor = P.Field;
            inner.ForeColor = P.Fg;
            inner.GotFocus += delegate { panel.Invalidate(); };
            inner.LostFocus += delegate { panel.Invalidate(); };
            panel.Controls.Add(inner);
            return panel;
        }

        protected void PlaceBottomRight()
        {
            Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(area.Right - Width - Px(24), area.Bottom - Height - Px(24));
        }
    }

    // ---------- The review / add card ----------

    class EditorForm : CardForm
    {
        const int MaxQuoteLength = 85; // two lines at full size on the new tab; matches the Chrome extension

        readonly Settings settings;
        readonly string sourceTitle;
        readonly TextBox box;
        readonly Label status;
        readonly Button save, cancel;
        bool saving;

        public EditorForm(string quote, string sourceTitle, Settings settings) : base(settings.Dark)
        {
            this.settings = settings;
            this.sourceTitle = sourceTitle;
            bool composing = quote.Length == 0;
            int pad = Px(16), width = Px(440);

            var mark = new Wordmark(P.Fg, 15 * S) { Location = new Point(pad, pad) };
            var mode = new Label
            {
                Text = composing ? "Add a quote" : "Review",
                ForeColor = P.Muted,
                Font = new Font("Segoe UI", 9f),
                AutoSize = true
            };

            box = new TextBox
            {
                Multiline = true,
                WordWrap = true,
                BorderStyle = BorderStyle.None,
                ScrollBars = ScrollBars.None,
                Font = new Font("Segoe UI Semibold", 12f),
                Text = quote
            };
            Panel field = MakeField(box, Px(104));
            field.SetBounds(pad, mark.Bottom + Px(12), width - pad * 2, Px(104));

            int y = field.Bottom;
            Label from = null;
            if (sourceTitle.Length > 0)
            {
                from = new Label
                {
                    Text = "From " + sourceTitle,
                    ForeColor = P.Muted,
                    Font = new Font("Segoe UI", 8.5f),
                    AutoEllipsis = true
                };
                from.SetBounds(pad, y + Px(6), width - pad * 2, Px(18));
                y = from.Bottom;
            }

            save = MakeButton("Save", true);
            cancel = MakeButton("Cancel", false);
            save.Location = new Point(width - pad - save.Width, y + Px(12));
            cancel.Location = new Point(save.Left - Px(8) - cancel.Width, save.Top);

            status = new Label
            {
                ForeColor = P.Muted,
                Font = new Font("Segoe UI", 8.5f),
                AutoEllipsis = true,
                TextAlign = ContentAlignment.MiddleLeft
            };
            status.SetBounds(pad, save.Top, cancel.Left - pad - Px(8), save.Height);

            ClientSize = new Size(width, save.Bottom + pad);
            mode.Location = new Point(width - pad - TextRenderer.MeasureText(mode.Text, mode.Font).Width, pad + Px(2));

            Controls.Add(mark);
            Controls.Add(mode);
            Controls.Add(field);
            if (from != null) Controls.Add(from);
            Controls.Add(status);
            Controls.Add(cancel);
            Controls.Add(save);

            save.Click += delegate { Save(); };
            cancel.Click += delegate { Close(); };
            box.KeyDown += OnBoxKeyDown;
            box.TextChanged += delegate { if (!saving) ShowCount(); };
            KeyDown += delegate(object s, KeyEventArgs e) { if (e.KeyCode == Keys.Escape) Close(); };
            ShowCount();

            PlaceBottomRight();
            Shown += delegate
            {
                Native.SetForegroundWindow(Handle);
                box.Focus();
                box.SelectionStart = box.TextLength;
            };
        }

        void OnBoxKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true;
                Save();
            }
            else if (e.KeyCode == Keys.Escape)
            {
                e.SuppressKeyPress = true;
                Close();
            }
        }

        void SetStatus(string text, Color color)
        {
            status.Text = text;
            status.ForeColor = color;
        }

        // Live character count, red when over the limit
        void ShowCount()
        {
            int n = QuoteText.Clean(box.Text).Length;
            if (n > MaxQuoteLength)
                SetStatus(n + " / " + MaxQuoteLength + " — trim it to fit two lines", P.Err);
            else
                SetStatus(n + " / " + MaxQuoteLength + " · Enter to save", P.Muted);
        }

        async void Save()
        {
            if (saving) return;
            string quote = QuoteText.Clean(box.Text);
            if (quote.Length == 0)
            {
                SetStatus("Write something first", P.Err);
                return;
            }
            if (quote.Length > MaxQuoteLength)
            {
                ShowCount();
                return;
            }

            saving = true;
            box.ReadOnly = save.Enabled = false;
            SetStatus("Saving…", P.Muted);

            Result result = await Api.Save(settings, quote, sourceTitle);
            if (IsDisposed) return;

            if (result.State == "error")
            {
                SetStatus(result.Message, P.Err);
                saving = false;
                box.ReadOnly = false;
                save.Enabled = true;
                box.Focus();
                return;
            }

            SetStatus(result.Message, P.Ok);
            await Task.Delay(1100);
            if (!IsDisposed) Close();
        }
    }

    // ---------- Settings ----------

    class SettingsForm : CardForm
    {
        readonly Settings settings;
        readonly TextBox name, linkedin, adminCode;
        readonly ComboBox theme;
        readonly CheckBox startup;
        readonly Label status;

        static readonly string[] ThemeValues = { "auto", "dark", "light" };
        static readonly string[] ThemeLabels = { "Match Windows", "Dark", "Light" };

        public SettingsForm(Settings settings) : base(settings.Dark)
        {
            this.settings = settings;
            int pad = Px(22), width = Px(420), inner = width - pad * 2;
            ShowInTaskbar = true;
            Text = "Underline settings";

            var mark = new Wordmark(P.Fg, 24 * S) { Location = new Point(pad, pad) };
            var intro = new Label
            {
                Text = "Select text in any app and press Ctrl+Shift+U. Your name is shown under every quote you save.",
                ForeColor = P.Muted
            };
            intro.SetBounds(pad, mark.Bottom + Px(10), inner, Px(40));

            int y = intro.Bottom + Px(14);
            name = new TextBox { BorderStyle = BorderStyle.None, Text = settings.Name, MaxLength = 80 };
            y = AddField("Name", name, pad, y, inner);
            linkedin = new TextBox { BorderStyle = BorderStyle.None, Text = settings.LinkedIn, MaxLength = 300 };
            y = AddField("LinkedIn profile (optional)", linkedin, pad, y, inner);
            adminCode = new TextBox { BorderStyle = BorderStyle.None, Text = settings.AdminCode, MaxLength = 200, UseSystemPasswordChar = true };
            y = AddField("Admin code (only for the sheet's owner)", adminCode, pad, y, inner);

            Controls.Add(MakeLabel("Appearance", pad, y));
            theme = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                FlatStyle = FlatStyle.Flat,
                BackColor = P.Field,
                ForeColor = P.Fg
            };
            theme.Items.AddRange(ThemeLabels);
            theme.SelectedIndex = Math.Max(0, Array.IndexOf(ThemeValues, settings.Theme));
            theme.SetBounds(pad, y + Px(22), Px(180), Px(28));
            Controls.Add(theme);
            y = theme.Bottom + Px(14);

            startup = new CheckBox
            {
                Text = "Start Underline when Windows starts",
                Checked = Settings.StartsWithWindows,
                ForeColor = P.Fg,
                AutoSize = true,
                Location = new Point(pad, y)
            };
            Controls.Add(startup);
            y = startup.Bottom + Px(18);

            // Messages get their own full-width line so they're never cut off
            status = new Label { ForeColor = P.Muted, TextAlign = ContentAlignment.MiddleLeft };
            status.SetBounds(pad, y, inner, Px(22));
            y = status.Bottom + Px(8);

            Button saveButton = MakeButton("Save", true);
            Button closeButton = MakeButton("Close", false);
            saveButton.Location = new Point(width - pad - saveButton.Width, y);
            closeButton.Location = new Point(saveButton.Left - Px(8) - closeButton.Width, y);

            Controls.Add(mark);
            Controls.Add(intro);
            Controls.Add(status);
            Controls.Add(closeButton);
            Controls.Add(saveButton);
            ClientSize = new Size(width, saveButton.Bottom + pad);

            saveButton.Click += delegate { SaveSettings(); };
            closeButton.Click += delegate { Close(); };
            AcceptButton = saveButton;
            KeyDown += delegate(object s, KeyEventArgs e) { if (e.KeyCode == Keys.Escape) Close(); };

            Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(area.Left + (area.Width - Width) / 2, area.Top + (area.Height - Height) / 2);
            Shown += delegate { Native.SetForegroundWindow(Handle); name.Focus(); };
        }

        Label MakeLabel(string text, int x, int y)
        {
            return new Label { Text = text, ForeColor = P.Muted, Font = new Font("Segoe UI", 9f), AutoSize = true, Location = new Point(x, y) };
        }

        int AddField(string label, TextBox box, int x, int y, int width)
        {
            Controls.Add(MakeLabel(label, x, y));
            box.Font = new Font("Segoe UI", 10.5f);
            Panel field = MakeField(box, Px(38));
            field.SetBounds(x, y + Px(22), width, Px(38));
            Controls.Add(field);
            return field.Bottom + Px(14);
        }

        async void SaveSettings()
        {
            string n = name.Text.Trim();
            string link = linkedin.Text.Trim();
            if (n.Length == 0)
            {
                status.ForeColor = P.Err;
                status.Text = "Add your name first";
                name.Focus();
                return;
            }
            // Accept "www.linkedin.com/in/..." or "linkedin.com/in/..." and add the https:// for them
            if (link.Length > 0 && !Regex.IsMatch(link, "^https?://", RegexOptions.IgnoreCase))
            {
                link = "https://" + link;
                linkedin.Text = link;
            }
            if (link.Length > 0 && !Regex.IsMatch(link, @"^https?://[^\s/]+\.[^\s]+$", RegexOptions.IgnoreCase))
            {
                status.ForeColor = P.Err;
                status.Text = "That doesn't look like a link — check your LinkedIn URL";
                linkedin.Focus();
                return;
            }

            // Check an admin code with the sheet before keeping it
            string code = adminCode.Text.Trim();
            if (code.Length > 0)
            {
                status.ForeColor = P.Muted;
                status.Text = "Checking the admin code…";
                bool? isAdmin = await Task.Run(() => Api.CheckAdminCode(code));
                if (IsDisposed) return;
                if (isAdmin != true)
                {
                    status.ForeColor = P.Err;
                    status.Text = isAdmin == null ? "Couldn't reach Google to check the admin code" : "That isn't the admin code";
                    adminCode.Focus();
                    return;
                }
            }

            settings.Name = n;
            settings.LinkedIn = link;
            settings.Theme = ThemeValues[Math.Max(0, theme.SelectedIndex)];
            settings.AdminCode = code;
            settings.Save();
            try { Settings.StartsWithWindows = startup.Checked; }
            catch (Exception) { } // a locked-down PC may block this; everything else still works

            status.ForeColor = P.Ok;
            status.Text = code.Length > 0 ? "Saved — admin: your quotes go live straight away" : "Saved — you're ready to underline";
        }
    }

    // ---------- Windows APIs ----------

    static class Native
    {
        public const uint MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_NOREPEAT = 0x4000;
        public const int WM_HOTKEY = 0x0312;
        const uint KEYEVENTF_KEYUP = 0x2;
        const byte VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_C = 0x43;

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);

        public static string WindowTitle(IntPtr hWnd)
        {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, sb.Capacity);
            return sb.ToString().Trim();
        }

        // Ctrl+C into whatever app is in front
        public static void SendCopy()
        {
            keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
            keybd_event(VK_C, 0, 0, UIntPtr.Zero);
            keybd_event(VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }
    }
}
