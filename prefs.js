import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
  captureStatusPresentation,
  normalizeAccelerator,
  parseRules,
  parseSelectedBindings,
  preferredWindowIdentity,
  redactRuntimeState,
  removeRuleById,
  restoreRuleAt,
} from './core.js';

const DEFAULT_SCHEMAS = [
  'org.gnome.desktop.wm.keybindings',
  'org.gnome.shell.keybindings',
  'org.gnome.mutter.keybindings',
  'org.gnome.mutter.wayland.keybindings',
  'org.gnome.settings-daemon.plugins.media-keys',
];
const MEDIA_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_SCHEMA =
  'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

function addSwitch(group, settings, key, title, subtitle = null) {
  const row = new Adw.SwitchRow({ title, subtitle });
  settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
  group.add(row);
  return row;
}

function addCombo(group, settings, key, title, values) {
  const model = new Gtk.StringList();
  values.forEach(([, label]) => model.append(label));
  const row = new Adw.ComboRow({ title, model });
  row.set_selected(
    Math.max(
      0,
      values.findIndex(([value]) => value === settings.get_string(key)),
    ),
  );
  row.connect('notify::selected', (widget) =>
    settings.set_string(key, values[widget.get_selected()][0]),
  );
  group.add(row);
  return row;
}

function readJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
}

function acceleratorLabel(accelerator) {
  const [valid, key, modifiers] = Gtk.accelerator_parse(accelerator);
  return valid ? Gtk.accelerator_get_label(key, modifiers) : accelerator;
}

function canonicalAccelerator(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const candidate = trimmed.includes('<')
    ? trimmed
    : trimmed
        .split('+')
        .map((part, index, parts) => {
          const value = part.trim();
          if (index === parts.length - 1) return value;
          const modifier = {
            ctrl: 'Control',
            control: 'Control',
            primary: 'Control',
            alt: 'Alt',
            shift: 'Shift',
            super: 'Super',
            meta: 'Meta',
          }[value.toLowerCase()];
          return modifier ? `<${modifier}>` : value;
        })
        .join('');

  const [valid, key, modifiers] = Gtk.accelerator_parse(candidate);
  return valid && Gtk.accelerator_valid(key, modifiers)
    ? Gtk.accelerator_name(key, modifiers)
    : '';
}

function addValidationRow(group) {
  const row = new Adw.ActionRow({ visible: false });
  row.add_prefix(new Gtk.Image({ icon_name: 'dialog-warning-symbolic' }));
  row.add_css_class('error');
  group.add(row);
  return row;
}

function setValidationError(field, errorRow, message = '') {
  field[message ? 'add_css_class' : 'remove_css_class']('error');
  field.update_property([Gtk.AccessibleProperty.DESCRIPTION], [message]);
  errorRow.title = message;
  errorRow.visible = Boolean(message);
}

export default class GnomeShortcutSuppressorPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    this._window = window;
    this._settings = this.getSettings();
    this._candidates = this._discoverExtensionBindings();
    this._runtime = this._readRuntime();

    window.set_default_size(780, 720);
    window.search_enabled = true;

    const pages = [
      this._buildGeneralPage(),
      this._buildTargetsPage(),
      this._buildSourcesPage(),
      this._buildDiagnosticsPage(),
    ];
    for (const page of pages) window.add(page);

    const requestedPage = this._settings.get_string(
      'requested-preferences-page',
    );
    const hasTargets =
      parseRules(this._settings.get_string('custom-window-rules-json')).rules
        .length > 0;
    window.set_visible_page_name(
      requestedPage === 'general' && !hasTargets ? 'targets' : requestedPage,
    );
    if (requestedPage !== 'general')
      this._settings.set_string('requested-preferences-page', 'general');

    this._runtimeSignal = this._settings.connect(
      'changed::runtime-state-json',
      () => {
        this._runtime = this._readRuntime();
        this._rebuildRecentWindows();
        this._rebuildDiagnostics();
      },
    );
    window.connect('close-request', () => {
      if (this._runtimeSignal) this._settings.disconnect(this._runtimeSignal);
      this._runtimeSignal = 0;
      return false;
    });
  }

  _buildGeneralPage() {
    const page = new Adw.PreferencesPage({
      name: 'general',
      title: 'General',
      icon_name: 'preferences-system-symbolic',
    });
    const capture = new Adw.PreferencesGroup({ title: 'Suppression' });
    addSwitch(
      capture,
      this._settings,
      'automatic-capture',
      'Automatic suppression',
      'Suppress local shortcuts when a configured target is focused',
    );
    addCombo(capture, this._settings, 'capture-scope', 'When to suppress', [
      ['focused', 'Target focused'],
      ['fullscreen', 'Target fullscreen'],
    ]);
    addCombo(capture, this._settings, 'indicator-mode', 'Panel indicator', [
      ['off', 'Off'],
      ['active', 'Active or warning'],
      ['always', 'Always'],
    ]);
    page.add(capture);

    const release = new Adw.PreferencesGroup({ title: 'Emergency restore' });
    release.add(this._buildReleaseShortcutRow());

    const exceptions = new Adw.EntryRow({
      title: 'Other shortcuts kept on this computer',
      show_apply_button: true,
    });
    release.add(exceptions);
    const exceptionError = addValidationRow(release);
    exceptions.set_text(this._settings.get_strv('local-exceptions').join(', '));
    exceptions.connect('apply', (row) => {
      const values = row
        .get_text()
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map(canonicalAccelerator);
      if (values.some((value) => !value)) {
        setValidationError(
          row,
          exceptionError,
          'Use comma-separated shortcuts, for example Super+L',
        );
        row.grab_focus();
        return;
      }
      setValidationError(row, exceptionError);
      this._settings.set_strv('local-exceptions', values);
    });
    exceptions.connect('changed', (row) =>
      setValidationError(row, exceptionError),
    );
    page.add(release);

    const logging = new Adw.PreferencesGroup({ title: 'Troubleshooting' });
    addSwitch(
      logging,
      this._settings,
      'debug-logging',
      'Debug logging',
      'Write state changes to the GNOME Shell journal',
    );
    page.add(logging);
    return page;
  }

  _buildReleaseShortcutRow() {
    const row = new Adw.ActionRow({
      title: 'Restore shortcuts',
      subtitle:
        'Always works on this computer and requires at least two modifiers',
      activatable: true,
    });
    const shortcut = new Gtk.ShortcutLabel({
      accelerator: this._settings.get_strv('release-capture')[0] ?? '',
      valign: Gtk.Align.CENTER,
    });
    row.add_suffix(shortcut);
    row.connect('activated', () => this._recordReleaseShortcut(shortcut));
    return row;
  }

  _recordReleaseShortcut(shortcutLabel) {
    const dialog = new Gtk.Dialog({
      title: 'Set restore shortcut',
      modal: true,
      transient_for: this._window,
      default_width: 420,
    });
    dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
    dialog.connect('response', () => dialog.close());
    const label = new Gtk.Label({
      label: 'Press a shortcut with at least two modifiers. Escape cancels.',
      margin_top: 32,
      margin_bottom: 32,
      margin_start: 24,
      margin_end: 24,
      wrap: true,
    });
    dialog.get_content_area().append(label);
    const controller = new Gtk.EventControllerKey({
      propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    controller.connect(
      'key-pressed',
      (_controller, keyval, _keycode, state) => {
        const modifiers =
          state &
          Gtk.accelerator_get_default_mod_mask() &
          ~Gdk.ModifierType.LOCK_MASK;
        if (keyval === Gdk.KEY_Escape && modifiers === 0) {
          dialog.close();
          return Gdk.EVENT_STOP;
        }

        const modifierMasks = [
          Gdk.ModifierType.CONTROL_MASK,
          Gdk.ModifierType.ALT_MASK,
          Gdk.ModifierType.SHIFT_MASK,
          Gdk.ModifierType.SUPER_MASK,
          Gdk.ModifierType.META_MASK,
          Gdk.ModifierType.HYPER_MASK,
        ];
        const modifierCount = modifierMasks.filter(
          (mask) => (modifiers & mask) !== 0,
        ).length;
        if (modifierCount < 2 || !Gtk.accelerator_valid(keyval, modifiers)) {
          label.label =
            'That shortcut is unsafe. Use a non-modifier key with at least two modifiers.';
          return Gdk.EVENT_STOP;
        }

        const accelerator = Gtk.accelerator_name(keyval, modifiers);
        this._settings.set_strv('release-capture', [accelerator]);
        shortcutLabel.accelerator = accelerator;
        dialog.close();
        return Gdk.EVENT_STOP;
      },
    );
    dialog.add_controller(controller);
    dialog.present();
  }

  _buildTargetsPage() {
    const page = new Adw.PreferencesPage({
      name: 'targets',
      title: 'Target Windows',
      icon_name: 'window-symbolic',
    });
    this._recentGroup = new Adw.PreferencesGroup({
      title: 'Add a recently focused window',
      description: 'Focus a target window, return here, then add it',
    });
    page.add(this._recentGroup);
    this._rebuildRecentWindows();

    this._rulesGroup = new Adw.PreferencesGroup({ title: 'Saved targets' });
    const addRule = new Gtk.Button({
      label: 'Add manually',
      valign: Gtk.Align.CENTER,
    });
    addRule.connect('clicked', () => this._newEmptyRule());
    this._rulesGroup.set_header_suffix(addRule);
    page.add(this._rulesGroup);
    this._rebuildRules();
    return page;
  }

  _rebuildRules() {
    for (const row of this._ruleRows ?? []) this._rulesGroup.remove(row);
    this._ruleRows = [];

    const { rules, errors } = parseRules(
      this._settings.get_string('custom-window-rules-json'),
    );
    for (const [index, rule] of rules.entries()) {
      const mode =
        rule.titleMode === 'any'
          ? 'Any title'
          : `${rule.titleMode}: ${rule.titlePattern}`;
      const row = new Adw.ActionRow({
        title: rule.name || rule.id,
        subtitle: `${mode}${rule.includeDialogs ? ' · dialogs included' : ''}`,
      });
      const edit = new Gtk.Button({
        icon_name: 'document-edit-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Edit target',
        has_frame: false,
      });
      const remove = new Gtk.Button({
        icon_name: 'edit-delete-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Delete target',
        has_frame: false,
      });
      edit.update_property(
        [Gtk.AccessibleProperty.LABEL],
        [`Edit ${rule.name || 'target'}`],
      );
      remove.update_property(
        [Gtk.AccessibleProperty.LABEL],
        [`Delete ${rule.name || 'target'}`],
      );
      edit.connect('clicked', () => this._editRule(rule));
      remove.connect('clicked', () => this._deleteRule(rule, index));
      row.add_suffix(edit);
      row.add_suffix(remove);
      this._rulesGroup.add(row);
      this._ruleRows.push(row);
    }

    for (const error of errors) {
      const row = new Adw.ActionRow({
        title: 'Invalid saved rule',
        subtitle: error,
      });
      this._rulesGroup.add(row);
      this._ruleRows.push(row);
    }
  }

  _rebuildRecentWindows() {
    for (const row of this._recentRows ?? []) this._recentGroup.remove(row);
    this._recentRows = [];

    for (const info of this._runtime.recentWindows ?? []) {
      const identity =
        info.appId ||
        info.gtkAppId ||
        info.sandboxedAppId ||
        info.wmClass ||
        info.wmClassInstance ||
        'Unknown application';
      const row = new Adw.ActionRow({
        title: info.title || identity,
        subtitle: identity,
      });
      const add = new Gtk.Button({
        label: 'Add target',
        valign: Gtk.Align.CENTER,
      });
      add.connect('clicked', () => this._newRuleFromWindow(info));
      row.add_suffix(add);
      this._recentGroup.add(row);
      this._recentRows.push(row);
    }

    if (this._recentRows.length === 0) {
      const row = new Adw.ActionRow({
        title: 'No windows observed yet',
        subtitle: 'Focus the target window, then return here.',
      });
      this._recentGroup.add(row);
      this._recentRows.push(row);
    }
  }

  _newEmptyRule() {
    this._editRule(
      {
        id: GLib.uuid_string_random(),
        name: '',
        enabled: true,
        identities: {},
        titleMode: 'any',
        titlePattern: '',
        includeDialogs: false,
      },
      true,
    );
  }

  _newRuleFromWindow(info) {
    const identities = preferredWindowIdentity(info);
    this._editRule(
      {
        id: GLib.uuid_string_random(),
        name: Object.values(identities)[0] ?? 'Target window',
        enabled: true,
        identities,
        titleMode: 'any',
        titlePattern: '',
        includeDialogs: false,
      },
      true,
    );
  }

  _editRule(rule, isNew = false) {
    const dialog = new Gtk.Dialog({
      title: isNew ? 'Add target window' : 'Edit target window',
      modal: true,
      transient_for: this._window,
      default_width: 520,
    });
    dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
    dialog.add_button('Save', Gtk.ResponseType.OK);

    const group = new Adw.PreferencesGroup({
      description:
        'A window matches when any identifier below matches. Usually Application ID is enough.',
      margin_top: 18,
      margin_bottom: 18,
      margin_start: 18,
      margin_end: 18,
    });
    const name = new Adw.EntryRow({ title: 'Name' });
    name.set_text(rule.name ?? '');
    group.add(name);

    const identityRows = {
      appId: new Adw.EntryRow({ title: 'Application ID' }),
    };
    identityRows.appId.set_text(rule.identities?.appId ?? '');
    group.add(identityRows.appId);

    const advancedIdentities = new Adw.ExpanderRow({
      title: 'Advanced identifiers',
      subtitle: 'A match on any field is enough',
      expanded: [
        'gtkAppId',
        'sandboxedAppId',
        'wmClass',
        'wmClassInstance',
      ].some((key) => Boolean(rule.identities?.[key])),
    });
    for (const [key, title] of [
      ['gtkAppId', 'GTK application ID'],
      ['sandboxedAppId', 'Sandboxed application ID'],
      ['wmClass', 'WM class'],
      ['wmClassInstance', 'WM class instance'],
    ]) {
      const row = new Adw.EntryRow({ title });
      row.set_text(rule.identities?.[key] ?? '');
      advancedIdentities.add_row(row);
      identityRows[key] = row;
    }
    group.add(advancedIdentities);
    const identityError = addValidationRow(group);

    const modes = [
      ['any', 'Any title'],
      ['contains', 'Contains'],
      ['regex', 'Regular expression'],
    ];
    const model = new Gtk.StringList();
    modes.forEach(([, label]) => model.append(label));
    const titleMode = new Adw.ComboRow({ title: 'Title match', model });
    titleMode.set_selected(
      Math.max(
        0,
        modes.findIndex(([value]) => value === rule.titleMode),
      ),
    );
    group.add(titleMode);

    const pattern = new Adw.EntryRow({ title: 'Title pattern' });
    pattern.set_text(rule.titlePattern ?? '');
    group.add(pattern);
    const patternError = addValidationRow(group);
    const syncTitlePattern = () => {
      pattern.visible = modes[titleMode.get_selected()][0] !== 'any';
      if (!pattern.visible) setValidationError(pattern, patternError);
    };
    titleMode.connect('notify::selected', syncTitlePattern);
    syncTitlePattern();

    for (const row of Object.values(identityRows))
      row.connect('changed', () =>
        setValidationError(identityRows.appId, identityError),
      );
    pattern.connect('changed', () => setValidationError(pattern, patternError));

    const dialogs = new Adw.SwitchRow({
      title: 'Include dialogs and transient windows',
      active: rule.includeDialogs ?? false,
    });
    group.add(dialogs);
    dialog.get_content_area().append(group);

    dialog.connect('response', (_dialog, response) => {
      if (response !== Gtk.ResponseType.OK) {
        dialog.close();
        return;
      }
      const identities = Object.fromEntries(
        Object.entries(identityRows)
          .map(([key, row]) => [key, row.get_text().trim()])
          .filter(([, value]) => value.length > 0),
      );
      if (Object.keys(identities).length === 0) {
        setValidationError(
          identityRows.appId,
          identityError,
          'Enter at least one identifier, usually Application ID',
        );
        identityRows.appId.grab_focus();
        return;
      }

      const selectedMode = modes[titleMode.get_selected()][0];
      if (selectedMode !== 'any' && !pattern.get_text().trim()) {
        setValidationError(
          pattern,
          patternError,
          'Enter a title pattern or choose Any title',
        );
        pattern.grab_focus();
        return;
      }
      if (selectedMode === 'regex') {
        try {
          new RegExp(pattern.get_text(), 'i');
        } catch (_error) {
          setValidationError(
            pattern,
            patternError,
            'Enter a valid regular expression',
          );
          pattern.grab_focus();
          return;
        }
      }

      const updated = {
        ...rule,
        name: name.get_text().trim() || rule.id,
        identities,
        titleMode: selectedMode,
        titlePattern: pattern.get_text(),
        includeDialogs: dialogs.get_active(),
      };
      const { rules } = parseRules(
        this._settings.get_string('custom-window-rules-json'),
      );
      const next = isNew
        ? [...rules, updated]
        : rules.map((candidate) =>
            candidate.id === rule.id ? updated : candidate,
          );
      this._saveRules(next);
      dialog.close();
    });
    dialog.present();
  }

  _deleteRule(rule, index) {
    const { rules } = parseRules(
      this._settings.get_string('custom-window-rules-json'),
    );
    this._saveRules(removeRuleById(rules, rule.id));

    const toast = new Adw.Toast({
      title: 'Target deleted',
      button_label: 'Undo',
    });
    toast.connect('button-clicked', () => {
      const current = parseRules(
        this._settings.get_string('custom-window-rules-json'),
      ).rules;
      this._saveRules(restoreRuleAt(current, rule, index));
    });
    this._window.add_toast(toast);
  }

  _saveRules(rules) {
    this._settings.set_string(
      'custom-window-rules-json',
      JSON.stringify(rules),
    );
    this._rebuildRules();
  }

  _buildSourcesPage() {
    const page = new Adw.PreferencesPage({
      name: 'sources',
      title: 'Shortcuts',
      icon_name: 'input-keyboard-symbolic',
    });

    const coverage = new Adw.PreferencesGroup({
      title: 'Coverage',
      description:
        'Standard suppresses GNOME shortcuts. Extended can also suppress selected extension shortcuts and active app grabs.',
    });
    const mode = addCombo(
      coverage,
      this._settings,
      'capture-mode',
      'Shortcut coverage',
      [
        ['standard', 'Standard'],
        ['aggressive', 'Extended'],
      ],
    );
    const runtimeGrabs = addSwitch(
      coverage,
      this._settings,
      'capture-runtime-grabs',
      'Active app and extension grabs',
      'GNOME cannot identify their owners; newly registered grabs wait until the next suppression',
    );
    page.add(coverage);

    const builtins = new Adw.PreferencesGroup({
      title: 'GNOME shortcut groups',
      description:
        'Turn off a group to keep those shortcuts available on this computer.',
    });
    for (const [key, title] of [
      ['capture-wm-shortcuts', 'Window manager'],
      ['capture-shell-shortcuts', 'GNOME Shell'],
      ['capture-mutter-shortcuts', 'Mutter'],
      ['capture-wayland-shortcuts', 'Wayland session'],
      ['capture-media-shortcuts', 'Media and application keys'],
      ['capture-custom-shortcuts', 'Custom keyboard shortcuts'],
      ['capture-overlay-key', 'Super / overview key'],
    ])
      addSwitch(builtins, this._settings, key, title);
    page.add(builtins);

    const local = new Adw.PreferencesGroup({
      title: 'Always keep on this computer',
      description:
        'Selected groups remain available even while other shortcuts are suppressed.',
    });
    for (const [key, title, subtitle] of [
      ['keep-hardware-keys-local', 'Hardware and media controls'],
      [
        'keep-power-keys-local',
        'Power, lock, and session controls',
        'Lock, logout, power, and virtual terminals',
      ],
      ['keep-accessibility-keys-local', 'Accessibility shortcuts'],
      ['keep-screenshot-keys-local', 'Screenshots and screen recording'],
    ])
      addSwitch(local, this._settings, key, title, subtitle);
    page.add(local);

    const extensions = new Adw.PreferencesGroup({
      title: 'Extension shortcuts',
      description: 'Choose individual shortcuts to suppress in Extended mode.',
    });
    const { items } = parseSelectedBindings(
      this._settings.get_string('selected-extension-bindings-json'),
    );
    const selected = new Set(items.map((item) => this._descriptorId(item)));
    for (const candidate of this._candidates) {
      const row = new Adw.SwitchRow({
        title: `${candidate.extensionName}: ${candidate.key}`,
        subtitle: candidate.bindings.map(acceleratorLabel).join(' / '),
        active: selected.has(this._descriptorId(candidate)),
      });
      row.connect('notify::active', (widget) =>
        this._toggleExtensionBinding(candidate, widget.get_active()),
      );
      extensions.add(row);
    }
    if (this._candidates.length === 0)
      extensions.add(
        new Adw.ActionRow({ title: 'No extension shortcuts found' }),
      );
    page.add(extensions);

    const syncExtendedControls = () => {
      const extended = mode.get_selected() === 1;
      runtimeGrabs.sensitive = extended;
      extensions.sensitive = extended;
    };
    mode.connect('notify::selected', syncExtendedControls);
    syncExtendedControls();
    return page;
  }

  _toggleExtensionBinding(candidate, enabled) {
    const { items } = parseSelectedBindings(
      this._settings.get_string('selected-extension-bindings-json'),
    );
    const id = this._descriptorId(candidate);
    const retained = items.filter((item) => this._descriptorId(item) !== id);
    if (enabled)
      retained.push({
        uuid: candidate.uuid,
        schemaId: candidate.schemaId,
        key: candidate.key,
      });
    this._settings.set_string(
      'selected-extension-bindings-json',
      JSON.stringify(retained),
    );
  }

  _descriptorId(item) {
    return `${item.uuid}:${item.schemaId}:${item.key}`;
  }

  _buildDiagnosticsPage() {
    const page = new Adw.PreferencesPage({
      name: 'diagnostics',
      title: 'Diagnostics',
      icon_name: 'dialog-information-symbolic',
    });
    this._statusGroup = new Adw.PreferencesGroup({ title: 'Runtime' });
    this._focusedGroup = new Adw.PreferencesGroup({ title: 'Focused window' });
    this._recentDiagnosticsGroup = new Adw.PreferencesGroup({
      title: 'Recent windows',
    });
    this._suppressedGroup = new Adw.PreferencesGroup({
      title: 'Suppressed shortcuts',
    });
    this._warningGroup = new Adw.PreferencesGroup({
      title: 'Warnings this session',
    });
    page.add(this._statusGroup);
    page.add(this._focusedGroup);
    page.add(this._recentDiagnosticsGroup);

    const finder = new Adw.PreferencesGroup({
      title: 'Find shortcut source',
      description:
        'Searches known GSettings sources; runtime-only grabs cannot be identified safely.',
    });
    const search = new Adw.EntryRow({ title: 'Shortcut, for example Super+W' });
    this._searchResult = new Adw.ActionRow({
      title: 'Matches',
      subtitle: 'Enter a shortcut',
    });
    search.connect('changed', (row) =>
      this._updateShortcutSearch(row.get_text()),
    );
    finder.add(search);
    finder.add(this._searchResult);
    page.add(finder);

    page.add(this._suppressedGroup);
    page.add(this._warningGroup);

    const copy = new Adw.PreferencesGroup({ title: 'Copy diagnostics' });
    this._includeTitles = new Adw.SwitchRow({
      title: 'Include window titles',
      subtitle: 'Off by default because titles may contain private information',
    });
    copy.add(this._includeTitles);
    const copyRow = new Adw.ActionRow({
      title: 'Copy report',
      activatable: true,
      subtitle: 'Custom shortcut commands are never included',
    });
    copyRow.add_suffix(new Gtk.Image({ icon_name: 'edit-copy-symbolic' }));
    copyRow.connect('activated', () => this._copyDiagnostics());
    copy.add(copyRow);
    page.add(copy);

    this._rebuildDiagnostics();
    return page;
  }

  _rebuildDiagnostics() {
    const presentation = captureStatusPresentation(this._runtime);
    const statusRows = [
      new Adw.ActionRow({
        title: 'Suppression status',
        subtitle: presentation.diagnosticsLabel,
      }),
      new Adw.ActionRow({
        title: 'Matched target',
        subtitle: this._runtime.matchedRule?.name ?? 'None',
      }),
      new Adw.ActionRow({
        title: 'Last event',
        subtitle: this._runtime.message || 'None',
      }),
    ];
    if (presentation.action)
      statusRows.push(
        new Adw.ActionRow({
          title: 'What to do',
          subtitle: presentation.action,
        }),
      );
    this._replaceRows(this._statusGroup, '_statusRows', statusRows);

    const focused = this._runtime.focusedWindow;
    const focusedRows = focused
      ? [
          ['Application ID', focused.appId],
          ['GTK application ID', focused.gtkAppId],
          ['Sandboxed application ID', focused.sandboxedAppId],
          ['WM class', focused.wmClass],
          ['WM class instance', focused.wmClassInstance],
          ['Title', focused.title],
          ['Dialog', focused.isDialog ? 'Yes' : 'No'],
        ]
          .filter(
            ([, value]) =>
              value !== '' && value !== null && value !== undefined,
          )
          .map(
            ([title, subtitle]) =>
              new Adw.ActionRow({ title, subtitle: String(subtitle) }),
          )
      : [new Adw.ActionRow({ title: 'No focused window reported' })];
    this._replaceRows(this._focusedGroup, '_focusedRows', focusedRows);

    const recentRows = (this._runtime.recentWindows ?? []).map((info) => {
      const identifiers = [
        info.appId,
        info.gtkAppId,
        info.sandboxedAppId,
        info.wmClass,
        info.wmClassInstance,
      ].filter(Boolean);
      return new Adw.ActionRow({
        title: identifiers[0] ?? 'Unknown application',
        subtitle: [info.title, ...identifiers.slice(1)]
          .filter(Boolean)
          .join(' · '),
      });
    });
    if (recentRows.length === 0)
      recentRows.push(
        new Adw.ActionRow({ title: 'No recent windows reported' }),
      );
    this._replaceRows(
      this._recentDiagnosticsGroup,
      '_recentDiagnosticsRows',
      recentRows,
    );

    const suppressed = this._runtime.suppressed ?? [];
    const suppressedRows = suppressed.map((item) => {
      const subtitle = item.schemaId
        ? `${item.uuid ? `${item.uuid} · ` : ''}${item.schemaId}${item.path ? ` · ${item.path}` : ''}`
        : (item.source ?? '');
      return new Adw.ActionRow({ title: item.key, subtitle });
    });
    if (suppressedRows.length === 0)
      suppressedRows.push(
        new Adw.ActionRow({ title: 'No bindings currently suppressed' }),
      );
    this._replaceRows(this._suppressedGroup, '_suppressedRows', suppressedRows);

    const warnings = this._runtime.warnings ?? [];
    const warningRows = warnings.map(
      (warning) => new Adw.ActionRow({ title: warning }),
    );
    if (warningRows.length === 0)
      warningRows.push(new Adw.ActionRow({ title: 'No warnings' }));
    this._replaceRows(this._warningGroup, '_warningRows', warningRows);
  }

  _replaceRows(group, property, rows) {
    for (const row of this[property] ?? []) group.remove(row);
    this[property] = rows;
    rows.forEach((row) => group.add(row));
  }

  _updateShortcutSearch(text) {
    const accelerator = canonicalAccelerator(text);
    if (!accelerator) {
      this._searchResult.subtitle = text.trim()
        ? 'Invalid shortcut'
        : 'Enter a shortcut';
      return;
    }
    const normalized = normalizeAccelerator(accelerator);
    const matches = this._knownBindings().filter((item) =>
      item.bindings.some(
        (binding) => normalizeAccelerator(binding) === normalized,
      ),
    );
    this._searchResult.subtitle =
      matches.length > 0
        ? matches.map((item) => item.label).join('\n')
        : 'No known GSettings binding; it may be runtime-only.';
  }

  _knownBindings() {
    const result = [];
    for (const schemaId of DEFAULT_SCHEMAS) {
      const schema = Gio.SettingsSchemaSource.get_default()?.lookup(
        schemaId,
        true,
      );
      if (!schema) continue;
      const settings = new Gio.Settings({ settings_schema: schema });
      for (const key of schema.list_keys()) {
        const value = settings.get_value(key);
        if (
          value.get_type_string() !== 'as' ||
          (schemaId === MEDIA_SCHEMA && key === 'custom-keybindings')
        )
          continue;
        const bindings = value.deep_unpack().filter(Boolean);
        if (bindings.length > 0)
          result.push({ label: `${schemaId}: ${key}`, bindings });
      }
    }

    const mutter = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    result.push({
      label: 'org.gnome.mutter: overlay-key',
      bindings: [mutter.get_string('overlay-key')].filter(Boolean),
    });

    const media = new Gio.Settings({ schema_id: MEDIA_SCHEMA });
    for (const path of media.get_strv('custom-keybindings')) {
      const settings = new Gio.Settings({ schema_id: CUSTOM_SCHEMA, path });
      const binding = settings.get_string('binding');
      if (binding)
        result.push({
          label: `${settings.get_string('name') || 'Custom shortcut'} · ${path}`,
          bindings: [binding],
        });
    }

    result.push(
      ...this._candidates.map((candidate) => ({
        label: `${candidate.extensionName}: ${candidate.key}`,
        bindings: candidate.bindings,
      })),
    );
    return result;
  }

  _copyDiagnostics() {
    const report = this._includeTitles.get_active()
      ? this._runtime
      : redactRuntimeState(this._runtime);
    Gdk.Display.get_default()
      .get_clipboard()
      .set(JSON.stringify(report, null, 2));
    this._window.add_toast(new Adw.Toast({ title: 'Diagnostics copied' }));
  }

  _readRuntime() {
    return readJson(this._settings.get_string('runtime-state-json'), {
      status: 'unknown',
      focusedWindow: null,
      recentWindows: [],
      matchedRule: null,
      suppressed: [],
      warnings: [],
      message: '',
    });
  }

  _discoverExtensionBindings() {
    let enabled;
    try {
      enabled = new Gio.Settings({ schema_id: 'org.gnome.shell' }).get_strv(
        'enabled-extensions',
      );
    } catch (_error) {
      return [];
    }

    const candidates = [];
    for (const uuid of enabled) {
      if (uuid === this.metadata.uuid) continue;
      const directory = this._findExtensionDirectory(uuid);
      if (!directory) continue;
      const schemaDirectory = GLib.build_filenamev([directory, 'schemas']);
      if (
        !Gio.File.new_for_path(
          GLib.build_filenamev([schemaDirectory, 'gschemas.compiled']),
        ).query_exists(null)
      )
        continue;

      let source;
      try {
        source = Gio.SettingsSchemaSource.new_from_directory(
          schemaDirectory,
          Gio.SettingsSchemaSource.get_default(),
          false,
        );
      } catch (_error) {
        continue;
      }

      const extensionName = this._extensionName(directory, uuid);
      const [schemaIds] = source.list_schemas(false);
      for (const schemaId of schemaIds) {
        const schema = source.lookup(schemaId, false);
        if (!schema || schema.get_path() === null) continue;
        const settings = new Gio.Settings({ settings_schema: schema });
        for (const key of schema.list_keys()) {
          const value = settings.get_value(key);
          if (value.get_type_string() !== 'as') continue;
          const bindings = value.deep_unpack().filter(Boolean);
          if (
            bindings.length === 0 ||
            !bindings.every((binding) => {
              const [valid, keyval, modifiers] = Gtk.accelerator_parse(binding);
              return valid && Gtk.accelerator_valid(keyval, modifiers);
            })
          )
            continue;
          candidates.push({ uuid, extensionName, schemaId, key, bindings });
        }
      }
    }

    return candidates.sort((a, b) =>
      `${a.extensionName}:${a.key}`.localeCompare(
        `${b.extensionName}:${b.key}`,
      ),
    );
  }

  _extensionName(directory, uuid) {
    try {
      const [ok, contents] = Gio.File.new_for_path(
        GLib.build_filenamev([directory, 'metadata.json']),
      ).load_contents(null);
      if (ok)
        return JSON.parse(new TextDecoder().decode(contents)).name ?? uuid;
    } catch (_error) {}
    return uuid;
  }

  _findExtensionDirectory(uuid) {
    for (const root of [
      GLib.get_user_data_dir(),
      ...GLib.get_system_data_dirs(),
    ]) {
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
}
