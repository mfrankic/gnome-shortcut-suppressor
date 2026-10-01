import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
  allowsCapture,
  bindingCategory,
  captureDecision,
  captureStatusPresentation,
  filterAccelerators,
  isRecoveryPending,
  matchesRule,
  normalizeAccelerator,
  parseJournal,
  parseRules,
  parseSelectedBindings,
  selectRuntimeGrabs,
  serializeJournal,
  shouldResumeRuntimeRecovery,
  shouldRestore,
} from './core.js';

const DEFAULT_SOURCES = [
  ['capture-wm-shortcuts', 'org.gnome.desktop.wm.keybindings'],
  ['capture-shell-shortcuts', 'org.gnome.shell.keybindings'],
  ['capture-mutter-shortcuts', 'org.gnome.mutter.keybindings'],
  ['capture-wayland-shortcuts', 'org.gnome.mutter.wayland.keybindings'],
  ['capture-media-shortcuts', 'org.gnome.settings-daemon.plugins.media-keys'],
];

const CUSTOM_SCHEMA =
  'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
const MEDIA_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const RUNTIME_GRAB_SOURCE = 'Runtime accelerator grab.';
// ponytail: 200ms coalesce; a shell crash in that window drops diagnostics only
const RUNTIME_WRITE_MS = 200;
// ponytail: GNOME keeps extension modules loaded across toggles; if that changes, use a Shell-provided process token.
const SHELL_INSTANCE_ID = GLib.uuid_string_random();

const CONFIG_KEYS = new Set([
  'automatic-capture',
  'capture-mode',
  'capture-scope',
  'capture-runtime-grabs',
  'indicator-mode',
  'release-capture',
  'local-exceptions',
  'custom-window-rules-json',
  'capture-wm-shortcuts',
  'capture-shell-shortcuts',
  'capture-mutter-shortcuts',
  'capture-wayland-shortcuts',
  'capture-media-shortcuts',
  'capture-custom-shortcuts',
  'capture-overlay-key',
  'keep-hardware-keys-local',
  'keep-power-keys-local',
  'keep-accessibility-keys-local',
  'keep-screenshot-keys-local',
  'selected-extension-bindings-json',
  'debug-logging',
]);

const CaptureIndicator = GObject.registerClass(
  class CaptureIndicator extends PanelMenu.Button {
    _init(extension) {
      super._init(0.0, 'GNOME Shortcut Suppressor');
      this._extension = extension;
      this.add_child(
        new St.Icon({
          icon_name: 'input-keyboard-symbolic',
          style_class: 'system-status-icon',
        }),
      );

      this._status = new PopupMenu.PopupMenuItem('Local shortcuts available', {
        reactive: false,
      });
      this._detail = new PopupMenu.PopupMenuItem('', { reactive: false });
      this._capture = new PopupMenu.PopupMenuItem('Suppress now');
      this._release = new PopupMenu.PopupMenuItem('Restore now');
      const preferences = new PopupMenu.PopupMenuItem('Preferences');
      const diagnostics = new PopupMenu.PopupMenuItem('Diagnostics');

      this._capture.connect('activate', () => extension.captureNow());
      this._release.connect('activate', () => extension.releaseNow());
      preferences.connect('activate', () => extension.openPreferences());
      diagnostics.connect('activate', () => extension.openDiagnostics());

      this.menu.addMenuItem(this._status);
      this.menu.addMenuItem(this._detail);
      this.menu.addMenuItem(this._capture);
      this.menu.addMenuItem(this._release);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(preferences);
      this.menu.addMenuItem(diagnostics);
    }

    sync(runtime, active) {
      const presentation = captureStatusPresentation(runtime);
      this._status.label.text = presentation.label;
      this._detail.label.text = presentation.detail;
      this._detail.visible = Boolean(presentation.detail);
      this._capture.visible = !active && runtime.status !== 'recovery-pending';
      this._release.visible = active;
      this.set_accessible_name(
        [presentation.label, presentation.detail].filter(Boolean).join('. '),
      );
    }
  },
);

export default class GnomeShortcutSuppressorExtension extends Extension {
  enable() {
    this._active = false;
    this._runtimeGrabs = [];
    this._captureWindowId = null;
    this._manualPendingWindowId = null;
    this._suspendedWindowId = null;
    this._settingsCache = new Map();
    this._warnings = [];
    this._updateSource = 0;
    this._runtimeWriteSource = 0;
    this._runtimeJson = null;
    this._focusWindow = null;
    this._focusWindowSignal = 0;
    this._fullscreenSignal = 0;
    this._indicator = null;
    this._settings = this.getSettings();
    this._runtime = this._loadRuntime();

    this._recoverJournal();
    this._registerReleaseShortcut();

    this._settingsSignal = this._settings.connect(
      'changed',
      (_settings, key) => {
        if (CONFIG_KEYS.has(key)) this._scheduleRebuild();
      },
    );

    const mediaSettings = this._getDefaultSettings(MEDIA_SCHEMA);
    this._customPathsSignal =
      mediaSettings?.connect('changed::custom-keybindings', () =>
        this._scheduleRebuild(),
      ) ?? 0;

    this._focusSignal = global.display.connect('notify::focus-window', () =>
      this._updateFocus(),
    );

    this._updateFocus();
  }

  disable() {
    if (this._updateSource) {
      GLib.source_remove(this._updateSource);
      this._updateSource = 0;
    }
    this._disconnectFocusWatch();
    if (this._focusSignal) {
      global.display.disconnect(this._focusSignal);
      this._focusSignal = 0;
    }
    if (this._customPathsSignal) {
      this._getDefaultSettings(MEDIA_SCHEMA)?.disconnect(
        this._customPathsSignal,
      );
      this._customPathsSignal = 0;
    }
    if (this._settingsSignal) {
      this._settings.disconnect(this._settingsSignal);
      this._settingsSignal = 0;
    }

    Main.wm.removeKeybinding('release-capture');
    this._restoreCapture('Extension disabled', false);
    this._destroyIndicator();

    const journal = this._settings.get_string('recovery-journal-json');
    const runtimeRecoveryPending =
      this._runtimeGrabs.length > 0 ||
      this._runtime.runtimeRecoveryPending === true;
    const recoveryPending =
      isRecoveryPending(this._runtime, journal) || runtimeRecoveryPending;
    this._writeRuntime(
      {
        ...this._runtime,
        status: recoveryPending ? 'recovery-pending' : 'disabled',
        focusedWindow: null,
        matchedRule: null,
        suppressed: recoveryPending ? this._runtime.suppressed : [],
        runtimeRecoveryPending,
      },
      false,
    );
    const runtimePersisted = this._flushRuntime();
    if (recoveryPending && !runtimePersisted)
      console.error(
        `[${this.uuid}] Could not persist recovery status; restart GNOME Shell or sign out and back in`,
      );

    this._settingsCache.clear();
    this._settings = null;
    this._runtime = null;
  }

  captureNow() {
    const window = global.display.get_focus_window();
    if (!window || this._active) return;
    const journal = this._settings.get_string('recovery-journal-json');
    if (isRecoveryPending(this._runtime, journal)) {
      this._writeRuntime({
        ...this._runtime,
        status: 'recovery-pending',
      });
      return;
    }
    this._suspendedWindowId = null;
    const info = this._windowInfo(window);
    const matchedRule = { id: 'manual', name: 'current window' };
    if (!this._scopeAllows(window)) {
      this._manualPendingWindowId = info?.windowId ?? null;
      this._writeRuntime({
        ...this._runtime,
        status: 'waiting',
        focusedWindow: info,
        matchedRule,
        message: '',
      });
      return;
    }
    this._manualPendingWindowId = null;
    this._activateCapture(info, matchedRule);
  }

  releaseNow() {
    const window = global.display.get_focus_window();
    this._manualPendingWindowId = null;
    this._suspendedWindowId = window?.get_id() ?? null;
    if (this._runtime.status === 'waiting')
      this._writeRuntime({
        ...this._runtime,
        status: 'inactive',
        message: 'Automatic suppression paused until focus changes',
      });
    else this._restoreCapture('Restored manually');
  }

  openDiagnostics() {
    this._settings.set_string('requested-preferences-page', 'diagnostics');
    this.openPreferences();
  }

  _registerReleaseShortcut() {
    Main.wm.addKeybinding(
      'release-capture',
      this._settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => this.releaseNow(),
    );
  }

  _scheduleRebuild() {
    if (this._updateSource) return;
    this._updateSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._updateSource = 0;
      if (this._active) this._restoreCapture('Suppression settings changed');
      this._updateFocus();
      return GLib.SOURCE_REMOVE;
    });
  }

  _updateFocus() {
    const window = global.display.get_focus_window();
    this._watchFocusedWindow(window);
    const info = this._windowInfo(window);
    this._recordRecentWindow(info);

    if (
      this._manualPendingWindowId !== null &&
      info?.windowId !== this._manualPendingWindowId
    )
      this._manualPendingWindowId = null;

    if (
      this._suspendedWindowId !== null &&
      info?.windowId !== this._suspendedWindowId
    )
      this._suspendedWindowId = null;

    const scopeAllows = this._scopeAllows(window);
    if (this._active && info?.windowId !== this._captureWindowId)
      this._restoreCapture('Focus left target window');
    else if (this._active && !scopeAllows)
      this._restoreCapture('Target left fullscreen');

    const matchedRule = this._matchWindow(info);
    const manualRule =
      info?.windowId === this._manualPendingWindowId
        ? { id: 'manual', name: 'current window' }
        : null;
    this._runtime.focusedWindow = info;
    this._runtime.matchedRule = manualRule ?? matchedRule;
    this._runtime.warnings = this._warnings;

    const journal = this._settings.get_string('recovery-journal-json');
    if (isRecoveryPending(this._runtime, journal, this._active)) {
      this._runtime.status = 'recovery-pending';
      this._writeRuntime(this._runtime);
      return;
    }

    const suspended = info && info.windowId === this._suspendedWindowId;
    const decision = captureDecision({
      automatic: this._settings.get_boolean('automatic-capture'),
      matchedRule,
      manualRule,
      scopeAllows,
      suspended,
    });
    if (!this._active && decision.activate) {
      this._manualPendingWindowId = null;
      this._activateCapture(info, decision.rule);
    } else {
      if (!this._active && decision.waiting) {
        this._runtime.status = 'waiting';
        this._runtime.message = '';
      } else if (this._runtime.status === 'waiting') {
        this._runtime.status = 'inactive';
        this._runtime.message = '';
      }
      this._writeRuntime(this._runtime);
    }
  }

  _scopeAllows(window) {
    return allowsCapture(
      this._settings.get_string('capture-scope'),
      window?.is_fullscreen() === true,
    );
  }

  _disconnectFocusWatch() {
    if (!this._focusWindow) return;
    if (this._focusWindowSignal)
      this._focusWindow.disconnect(this._focusWindowSignal);
    if (this._fullscreenSignal)
      this._focusWindow.disconnect(this._fullscreenSignal);
    this._focusWindowSignal = 0;
    this._fullscreenSignal = 0;
  }

  _watchFocusedWindow(window) {
    if (window === this._focusWindow) return;
    this._disconnectFocusWatch();

    this._focusWindow = window;
    if (!window) return;

    this._focusWindowSignal = window.connect('unmanaged', () => {
      if (this._fullscreenSignal) {
        window.disconnect(this._fullscreenSignal);
        this._fullscreenSignal = 0;
      }
      this._focusWindowSignal = 0;
      this._focusWindow = null;
      if (window.get_id() === this._manualPendingWindowId)
        this._manualPendingWindowId = null;
      if (this._runtime.status === 'waiting')
        this._writeRuntime({
          ...this._runtime,
          status: 'inactive',
          focusedWindow: null,
          matchedRule: null,
          message: 'Target window closed',
        });
      else this._restoreCapture('Target window closed');
    });
    this._fullscreenSignal = window.connect('notify::fullscreen', () => {
      this._updateFocus();
    });
  }

  _windowInfo(window) {
    if (!window) return null;

    const type = window.get_window_type();
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return {
      windowId: window.get_id(),
      appId: app?.get_id() ?? '',
      gtkAppId: window.get_gtk_application_id() ?? '',
      sandboxedAppId: window.get_sandboxed_app_id() ?? '',
      wmClass: window.get_wm_class() ?? '',
      wmClassInstance: window.get_wm_class_instance() ?? '',
      title: window.get_title() ?? '',
      windowType: type,
      isNormal: type === Meta.WindowType.NORMAL,
      isDialog:
        type === Meta.WindowType.DIALOG ||
        type === Meta.WindowType.MODAL_DIALOG ||
        window.get_transient_for() != null,
    };
  }

  _matchWindow(info) {
    if (!info) return null;

    const { rules, errors } = parseRules(
      this._settings.get_string('custom-window-rules-json'),
    );
    errors.forEach((error) => this._warn(error));
    const rule = rules.find((candidate) => matchesRule(info, candidate));
    return rule ? { id: rule.id, name: rule.name || rule.id } : null;
  }

  _recordRecentWindow(info) {
    if (!info || this._isPreferencesWindow(info)) return;

    const identity = [
      info.appId,
      info.gtkAppId,
      info.sandboxedAppId,
      info.wmClass,
      info.wmClassInstance,
      info.title,
    ]
      .join('\0')
      .toLowerCase();
    const recent = (this._runtime.recentWindows ?? []).filter(
      (item) =>
        [
          item.appId,
          item.gtkAppId,
          item.sandboxedAppId,
          item.wmClass,
          item.wmClassInstance,
          item.title,
        ]
          .join('\0')
          .toLowerCase() !== identity,
    );
    this._runtime.recentWindows = [info, ...recent].slice(0, 10);
  }

  _isPreferencesWindow(info) {
    return (
      info.title.toLowerCase().includes('gnome shortcut suppressor') ||
      info.appId.toLowerCase().includes('org.gnome.shell.extensions')
    );
  }

  _activateCapture(info, matchedRule) {
    const journal = this._settings.get_string('recovery-journal-json');
    const runtimeRecoveryPending =
      this._runtime.runtimeRecoveryPending === true;
    if (isRecoveryPending(this._runtime, journal)) {
      const message = runtimeRecoveryPending
        ? 'Runtime shortcuts still need recovery; restart GNOME Shell or sign out and back in'
        : 'Suppression is blocked until pending shortcut recovery succeeds';
      this._warn(message);
      this._writeRuntime({
        ...this._runtime,
        status: 'recovery-pending',
        matchedRule,
        message,
        warnings: this._warnings,
        suppressed: this._runtime.suppressed,
      });
      return;
    }

    const entries = this._buildSuppressionPlan();
    const runtimePlan = this._buildRuntimeGrabPlan();
    if (entries.length === 0 && runtimePlan.length === 0) {
      this._writeRuntime({
        ...this._runtime,
        status: 'error',
        matchedRule,
        message: 'No writable shortcut settings were found',
        warnings: this._warnings,
        suppressed: [],
      });
      return;
    }

    if (entries.length > 0) {
      const journal = serializeJournal(entries);
      if (!this._settings.set_string('recovery-journal-json', journal)) {
        const message = 'Could not persist the shortcut recovery journal';
        this._warn(message);
        this._writeRuntime({
          ...this._runtime,
          status: 'error',
          matchedRule,
          message,
          warnings: this._warnings,
          suppressed: [],
        });
        return;
      }
      Gio.Settings.sync();
      if (this._settings.get_string('recovery-journal-json') !== journal) {
        const message = 'Shortcut recovery journal verification failed';
        this._warn(message);
        this._writeRuntime({
          ...this._runtime,
          status: 'error',
          matchedRule,
          message,
          warnings: this._warnings,
          suppressed: [],
        });
        return;
      }
    }

    try {
      for (const group of this._groupBySettings(entries)) {
        if (!group.settings)
          throw new Error(
            `Could not suppress ${group.entries[0].schemaId}:${group.entries[0].key}`,
          );
        this._commitDelayed(group.settings, () => {
          for (const entry of group.entries) {
            if (
              !group.settings.set_value(
                entry.key,
                new GLib.Variant(entry.type, entry.suppressedValue),
              )
            )
              throw new Error(
                `Could not suppress ${entry.schemaId}:${entry.key}`,
              );
          }
        });
      }
      this._applyRuntimeGrabs(runtimePlan);
    } catch (error) {
      this._warn(error.message);
      const gsettingsRestored = this._restoreJournal();
      const runtimeRestored = this._restoreRuntimeGrabs();
      const restored = gsettingsRestored && runtimeRestored;
      this._active = !restored;
      this._writeRuntime({
        ...this._runtime,
        status: restored ? 'error' : 'recovery-pending',
        matchedRule,
        message: restored
          ? error.message
          : 'Partial suppression rollback needs recovery',
        warnings: this._warnings,
        suppressed: restored
          ? []
          : this._captureDiagnostics(gsettingsRestored ? [] : entries),
        runtimeRecoveryPending: !runtimeRestored,
      });
      return;
    }

    this._active = true;
    this._captureWindowId = info?.windowId ?? null;
    this._writeRuntime({
      ...this._runtime,
      status: 'captured',
      matchedRule,
      message: '',
      warnings: this._warnings,
      suppressed: this._captureDiagnostics(entries),
      runtimeRecoveryPending: false,
    });
  }

  _buildSuppressionPlan() {
    const entries = [];
    const exceptions = [
      ...this._settings.get_strv('release-capture'),
      ...this._settings.get_strv('local-exceptions'),
    ];

    for (const [settingKey, schemaId] of DEFAULT_SOURCES) {
      if (!this._settings.get_boolean(settingKey)) continue;
      const settings = this._getDefaultSettings(schemaId);
      if (!settings) {
        this._warn(`Missing schema ${schemaId}`);
        continue;
      }

      for (const key of settings.settings_schema.list_keys()) {
        if (schemaId === MEDIA_SCHEMA && key === 'custom-keybindings') continue;
        if (settings.get_value(key).get_type_string() !== 'as') continue;
        if (this._keepLocal(schemaId, key)) continue;
        this._addPlanEntry(
          entries,
          settings,
          {
            source: 'default',
            schemaId,
            path: null,
            key,
          },
          exceptions,
        );
      }
    }

    if (this._settings.get_boolean('capture-custom-shortcuts'))
      this._addCustomShortcuts(entries, exceptions);

    if (this._settings.get_boolean('capture-overlay-key')) {
      const settings = this._getDefaultSettings('org.gnome.mutter');
      if (settings?.settings_schema.has_key('overlay-key'))
        this._addPlanEntry(
          entries,
          settings,
          {
            source: 'default',
            schemaId: 'org.gnome.mutter',
            path: null,
            key: 'overlay-key',
          },
          exceptions,
        );
    }

    if (this._settings.get_string('capture-mode') === 'aggressive')
      this._addSelectedExtensionBindings(entries, exceptions);

    return entries;
  }

  _buildRuntimeGrabPlan() {
    if (
      this._settings.get_string('capture-mode') !== 'aggressive' ||
      !this._settings.get_boolean('capture-runtime-grabs')
    )
      return [];

    const allowed = Main.wm._allowedKeybindings;
    if (!allowed || typeof Main.wm.allowKeybinding !== 'function') {
      this._warn(
        'GNOME runtime accelerator registry is unavailable; continuing without suppressing runtime grabs',
      );
      return [];
    }

    // ponytail: snapshot active grabs; wrap allowKeybinding only if mid-capture registration becomes a real issue.
    return selectRuntimeGrabs(allowed, Shell.ActionMode.NONE);
  }

  _applyRuntimeGrabs(plan) {
    this._runtimeGrabs = [];
    for (const grab of plan) {
      Main.wm.allowKeybinding(grab.name, Shell.ActionMode.NONE);
      if (Main.wm._allowedKeybindings?.[grab.name] !== Shell.ActionMode.NONE)
        throw new Error(`Could not suppress runtime grab ${grab.name}`);
      this._runtimeGrabs.push(grab);
    }
  }

  _restoreRuntimeGrabs() {
    if (this._runtimeGrabs.length === 0)
      return this._runtime.runtimeRecoveryPending !== true;

    const allowed = Main.wm._allowedKeybindings;
    if (!allowed || typeof Main.wm.allowKeybinding !== 'function') {
      this._warn(
        'GNOME runtime accelerator registry is unavailable; runtime grabs were not restored',
      );
      return false;
    }

    const unresolved = [];
    for (const grab of this._runtimeGrabs) {
      if (allowed[grab.name] !== Shell.ActionMode.NONE) {
        this._warn(`Preserved external change to runtime grab ${grab.name}`);
        continue;
      }
      Main.wm.allowKeybinding(grab.name, grab.modes);
      if (allowed[grab.name] !== grab.modes) {
        unresolved.push(grab);
        this._warn(`Could not restore runtime grab ${grab.name}`);
      }
    }
    this._runtimeGrabs = unresolved;
    return unresolved.length === 0;
  }

  _captureDiagnostics(entries) {
    return [
      ...entries.map((entry) => ({
        source: entry.source,
        uuid: entry.uuid ?? null,
        schemaId: entry.schemaId,
        path: entry.path ?? null,
        key: entry.key,
        binding: entry.originalValue,
      })),
      ...this._runtimeGrabs.map((grab) => ({
        source: RUNTIME_GRAB_SOURCE,
        uuid: null,
        schemaId: null,
        path: null,
        key: grab.name,
        binding: null,
      })),
    ];
  }

  _addCustomShortcuts(entries, exceptions) {
    const parent = this._getDefaultSettings(MEDIA_SCHEMA);
    for (const path of parent?.get_strv('custom-keybindings') ?? []) {
      const settings = this._getDefaultSettings(CUSTOM_SCHEMA, path);
      if (!settings) {
        this._warn(`Could not open custom shortcut ${path}`);
        continue;
      }
      this._addPlanEntry(
        entries,
        settings,
        {
          source: 'custom',
          schemaId: CUSTOM_SCHEMA,
          path,
          key: 'binding',
        },
        exceptions,
      );
    }
  }

  _addSelectedExtensionBindings(entries, exceptions) {
    const { items, errors } = parseSelectedBindings(
      this._settings.get_string('selected-extension-bindings-json'),
    );
    errors.forEach((error) => this._warn(error));
    for (const item of items) {
      const settings = this._getExtensionSettings(item.uuid, item.schemaId);
      if (!settings || !settings.settings_schema.has_key(item.key)) {
        this._warn(
          `Stale extension binding ${item.uuid}:${item.schemaId}:${item.key}`,
        );
        continue;
      }
      if (settings.get_value(item.key).get_type_string() !== 'as') {
        this._warn(
          `Extension binding is no longer an accelerator array: ${item.uuid}:${item.key}`,
        );
        continue;
      }
      const bindings = settings.get_strv(item.key).filter(Boolean);
      if (
        bindings.length === 0 ||
        !bindings.every((binding) => this._isAccelerator(binding))
      ) {
        this._warn(
          `Extension binding no longer contains only accelerators: ${item.uuid}:${item.key}`,
        );
        continue;
      }
      this._addPlanEntry(
        entries,
        settings,
        {
          source: 'extension',
          uuid: item.uuid,
          schemaId: item.schemaId,
          path: null,
          key: item.key,
        },
        exceptions,
      );
    }
  }

  _addPlanEntry(entries, settings, descriptor, exceptions) {
    if (!settings.is_writable(descriptor.key)) {
      this._warn(`Read-only shortcut ${descriptor.schemaId}:${descriptor.key}`);
      return;
    }

    const current = settings.get_value(descriptor.key);
    const type = current.get_type_string();
    const originalValue = current.deep_unpack();
    let suppressedValue;
    if (type === 'as')
      suppressedValue = filterAccelerators(originalValue, exceptions);
    else if (type === 's') {
      const normalizedExceptions = new Set(
        exceptions.map(normalizeAccelerator),
      );
      suppressedValue = normalizedExceptions.has(
        normalizeAccelerator(originalValue),
      )
        ? originalValue
        : '';
    } else {
      return;
    }

    if (shouldRestore(originalValue, suppressedValue)) return;

    const userValue = settings.get_user_value(descriptor.key);
    entries.push({
      ...descriptor,
      type,
      hadUserValue: userValue !== null,
      originalValue: userValue?.deep_unpack() ?? originalValue,
      suppressedValue,
    });
  }

  _keepLocal(schemaId, key) {
    const category = bindingCategory(schemaId, key);
    return (
      category !== null &&
      this._settings.get_boolean(`keep-${category}-keys-local`)
    );
  }

  _restoreCapture(message, syncIndicator = true) {
    if (
      !this._active &&
      this._runtimeGrabs.length === 0 &&
      this._runtime.runtimeRecoveryPending !== true &&
      this._settings.get_string('recovery-journal-json') === '[]'
    )
      return;

    const gsettingsRestored = this._restoreJournal();
    const runtimeRestored = this._restoreRuntimeGrabs();
    const restored = gsettingsRestored && runtimeRestored;
    this._active = !restored;
    if (restored) this._captureWindowId = null;
    this._writeRuntime(
      {
        ...this._runtime,
        status: restored ? 'inactive' : 'recovery-pending',
        message: restored
          ? message
          : 'Some shortcut settings still need recovery',
        suppressed: restored ? [] : this._runtime.suppressed,
        warnings: this._warnings,
        runtimeRecoveryPending: !runtimeRestored,
      },
      syncIndicator,
    );
  }

  _recoverJournal() {
    const journal = this._settings.get_string('recovery-journal-json');
    if (journal !== '[]') {
      this._warn('Recovered shortcut settings after interrupted suppression');
      this._active = !this._restoreJournal();
    }
  }

  _restoreJournal() {
    const journal = this._settings.get_string('recovery-journal-json');
    const { entries, errors } = parseJournal(journal);
    errors.forEach((error) => this._warn(error));
    if (errors.length > 0) return false;
    const unresolved = [];

    for (const group of this._groupBySettings(entries)) {
      const settings = group.settings;
      if (!settings) {
        for (const entry of group.entries) {
          unresolved.push(entry);
          this._warn(`Could not restore ${entry.schemaId}:${entry.key}`);
        }
        continue;
      }

      const pending = [];
      for (const entry of group.entries) {
        if (
          !settings.settings_schema.has_key(entry.key) ||
          settings.get_value(entry.key).get_type_string() !== entry.type ||
          !settings.is_writable(entry.key)
        ) {
          unresolved.push(entry);
          this._warn(`Could not restore ${entry.schemaId}:${entry.key}`);
          continue;
        }

        const current = settings.get_value(entry.key).deep_unpack();
        if (!shouldRestore(current, entry.suppressedValue)) {
          this._warn(
            `Preserved external change to ${entry.schemaId}:${entry.key}`,
          );
          continue;
        }
        pending.push(entry);
      }
      if (pending.length === 0) continue;

      try {
        this._commitDelayed(settings, () => {
          for (const entry of pending) {
            if (entry.hadUserValue) {
              if (
                !settings.set_value(
                  entry.key,
                  new GLib.Variant(entry.type, entry.originalValue),
                )
              )
                throw new Error('GSettings rejected the original value');
            } else {
              settings.reset(entry.key);
              if (settings.get_user_value(entry.key) !== null)
                throw new Error(
                  'GSettings did not clear the suppressed override',
                );
            }
          }
        });
      } catch (error) {
        for (const entry of pending) {
          unresolved.push(entry);
          this._warn(
            `Could not restore ${entry.schemaId}:${entry.key}: ${error.message}`,
          );
        }
      }
    }

    const remainingJournal = serializeJournal(unresolved);
    if (!this._settings.set_string('recovery-journal-json', remainingJournal)) {
      this._warn('Could not update the shortcut recovery journal');
      return false;
    }
    Gio.Settings.sync();
    if (
      this._settings.get_string('recovery-journal-json') !== remainingJournal
    ) {
      this._warn('Shortcut recovery journal update could not be verified');
      return false;
    }
    return unresolved.length === 0;
  }

  _groupBySettings(entries) {
    const groups = [];
    const index = new Map();
    for (const entry of entries) {
      const id = `${entry.source}\0${entry.uuid ?? ''}\0${entry.schemaId}\0${entry.path ?? ''}`;
      let group = index.get(id);
      if (!group) {
        group = { settings: this._freshSettings(entry), entries: [] };
        index.set(id, group);
        groups.push(group);
      }
      group.entries.push(entry);
    }
    return groups;
  }

  // ponytail: delay() is permanent on a Gio.Settings, so writers are not the cached readers
  _freshSettings(entry) {
    if (entry.source === 'extension')
      return this._getExtensionSettings(entry.uuid, entry.schemaId);

    const cached = this._getDefaultSettings(entry.schemaId, entry.path);
    if (!cached) return null;
    return entry.path
      ? new Gio.Settings({
          settings_schema: cached.settings_schema,
          path: entry.path,
        })
      : new Gio.Settings({ settings_schema: cached.settings_schema });
  }

  _commitDelayed(settings, write) {
    settings.delay();
    try {
      write();
      settings.apply();
    } catch (error) {
      settings.revert();
      throw error;
    }
  }

  _getDefaultSettings(schemaId, path = null) {
    const id = `${schemaId}:${path ?? ''}`;
    if (this._settingsCache.has(id)) return this._settingsCache.get(id);

    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(
      schemaId,
      true,
    );
    if (!schema) return null;

    const settings = path
      ? new Gio.Settings({ settings_schema: schema, path })
      : new Gio.Settings({ settings_schema: schema });
    this._settingsCache.set(id, settings);
    return settings;
  }

  _getExtensionSettings(uuid, schemaId) {
    const extensionDirectory = this._findExtensionDirectory(uuid);
    if (!extensionDirectory) return null;

    const schemaDirectory = GLib.build_filenamev([
      extensionDirectory,
      'schemas',
    ]);
    if (
      !Gio.File.new_for_path(
        GLib.build_filenamev([schemaDirectory, 'gschemas.compiled']),
      ).query_exists(null)
    )
      return null;

    try {
      const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDirectory,
        Gio.SettingsSchemaSource.get_default(),
        false,
      );
      const schema = source.lookup(schemaId, false);
      if (!schema || schema.get_path() === null) return null;
      return new Gio.Settings({ settings_schema: schema });
    } catch (error) {
      this._warn(`Could not load ${uuid} settings: ${error.message}`);
      return null;
    }
  }

  _findExtensionDirectory(uuid) {
    const roots = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    for (const root of roots) {
      const path = GLib.build_filenamev([
        root,
        'gnome-shell',
        'extensions',
        uuid,
      ]);
      if (Gio.File.new_for_path(path).query_exists(null)) return path;
    }
    return null;
  }

  _loadRuntime() {
    const runtime = {
      status: 'inactive',
      focusedWindow: null,
      recentWindows: [],
      matchedRule: null,
      suppressed: [],
      warnings: [],
      message: '',
      runtimeRecoveryPending: false,
      shellInstanceId: SHELL_INSTANCE_ID,
    };
    try {
      const saved = JSON.parse(this._settings.get_string('runtime-state-json'));
      if (Array.isArray(saved?.recentWindows))
        runtime.recentWindows = saved.recentWindows.slice(0, 10);
      if (shouldResumeRuntimeRecovery(saved, SHELL_INSTANCE_ID)) {
        runtime.status = 'recovery-pending';
        runtime.message =
          'Runtime shortcuts still need recovery; restart GNOME Shell or sign out and back in';
        runtime.suppressed = Array.isArray(saved.suppressed)
          ? saved.suppressed
          : [];
        runtime.runtimeRecoveryPending = true;
        this._warn(runtime.message);
        runtime.warnings = this._warnings;
      }
    } catch (_error) {}
    return runtime;
  }

  _writeRuntime(runtime, syncIndicator = true) {
    if (!this._settings) return;
    this._runtime = runtime;
    if (syncIndicator) this._syncIndicator();
    const json = JSON.stringify(runtime);
    this._queuedRuntimeJson = json;
    if (json === this._runtimeJson) {
      if (this._runtimeWriteSource) {
        GLib.source_remove(this._runtimeWriteSource);
        this._runtimeWriteSource = 0;
      }
      return;
    }
    if (this._runtimeWriteSource) GLib.source_remove(this._runtimeWriteSource);
    this._runtimeWriteSource = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      RUNTIME_WRITE_MS,
      () => {
        this._runtimeWriteSource = 0;
        this._flushRuntime();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _flushRuntime() {
    if (this._runtimeWriteSource) {
      GLib.source_remove(this._runtimeWriteSource);
      this._runtimeWriteSource = 0;
    }
    const json = this._queuedRuntimeJson;
    if (!this._settings || !json) return false;
    if (json === this._runtimeJson) return true;
    try {
      if (!this._settings.set_string('runtime-state-json', json)) {
        console.error(`[${this.uuid}] Could not write runtime status`);
        return false;
      }
      if (this._runtime.status === 'recovery-pending') {
        Gio.Settings.sync();
        if (this._settings.get_string('runtime-state-json') !== json) {
          console.error(`[${this.uuid}] Could not verify recovery status`);
          return false;
        }
      }
    } catch (error) {
      console.error(
        `[${this.uuid}] Could not persist runtime status: ${error}`,
      );
      return false;
    }
    this._runtimeJson = json;
    this._debug(`${this._runtime.status}: ${this._runtime.message ?? ''}`);
    return true;
  }

  _debug(message) {
    if (this._settings.get_boolean('debug-logging'))
      console.debug(`[${this.uuid}] ${message}`);
  }

  _warn(message) {
    if (!this._warnings.includes(message)) this._warnings.push(message);
  }

  _isAccelerator(accelerator) {
    if (typeof accelerator !== 'string') return false;
    const modifiers = accelerator.match(/^(?:<[^>]+>)*/)?.[0] ?? '';
    if (
      [...modifiers.matchAll(/<([^>]+)>/g)].some(
        (match) =>
          ![
            'shift',
            'ctrl',
            'control',
            'primary',
            'alt',
            'super',
            'hyper',
            'meta',
          ].includes(match[1].toLowerCase()),
      )
    )
      return false;
    const key = accelerator.slice(modifiers.length);
    const keyName = key.startsWith('XF86') ? key.slice(4) : key;
    return keyName.length > 0 && Clutter[`KEY_${keyName}`] !== undefined;
  }

  _syncIndicator() {
    const presentation = captureStatusPresentation(this._runtime);
    const mode = this._settings.get_string('indicator-mode');
    const visible =
      mode === 'always' ||
      (mode === 'active' && (this._active || presentation.needsAttention));
    if (!visible) {
      this._destroyIndicator();
      return;
    }

    if (!this._indicator) {
      this._indicator = new CaptureIndicator(this);
      Main.panel.addToStatusArea(this.uuid, this._indicator);
    }
    this._indicator.sync(this._runtime, this._active);
  }

  _destroyIndicator() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
