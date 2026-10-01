const MODIFIERS = new Map([
  ['shift', 'Shift'],
  ['ctrl', 'Primary'],
  ['control', 'Primary'],
  ['primary', 'Primary'],
  ['alt', 'Alt'],
  ['super', 'Super'],
  ['hyper', 'Hyper'],
  ['meta', 'Meta'],
]);

const MODIFIER_ORDER = ['Shift', 'Primary', 'Alt', 'Super', 'Hyper', 'Meta'];

export function normalizeAccelerator(accelerator) {
  if (typeof accelerator !== 'string') return '';

  const modifiers = new Set();
  for (const match of accelerator.matchAll(/<([^>]+)>/g)) {
    const modifier = MODIFIERS.get(match[1].toLowerCase());
    if (modifier) modifiers.add(modifier);
  }

  const key = accelerator
    .replaceAll(/<[^>]+>/g, '')
    .trim()
    .toLowerCase();
  return (
    MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
      .map((modifier) => `<${modifier}>`)
      .join('') + key
  );
}

export function filterAccelerators(accelerators, exceptions) {
  const normalizedExceptions = new Set(exceptions.map(normalizeAccelerator));
  return accelerators.filter((accelerator) =>
    normalizedExceptions.has(normalizeAccelerator(accelerator)),
  );
}

const IDENTITY_FIELDS = [
  'appId',
  'gtkAppId',
  'sandboxedAppId',
  'wmClass',
  'wmClassInstance',
];

export function preferredWindowIdentity(windowInfo) {
  for (const field of IDENTITY_FIELDS) {
    const value = windowInfo?.[field];
    if (typeof value === 'string' && value.trim())
      return { [field]: value.trim() };
  }
  return {};
}

export function captureStatusPresentation(runtime) {
  const status = runtime?.status ?? 'unknown';
  const message = runtime?.message ?? '';
  const target = runtime?.matchedRule?.name;

  switch (status) {
    case 'captured':
      return {
        label: target
          ? `Local shortcuts suppressed for ${target}`
          : 'Local shortcuts suppressed',
        detail: '',
        diagnosticsLabel: 'Active',
        action: '',
        needsAttention: false,
      };
    case 'waiting':
      return {
        label: target
          ? `Waiting for ${target} to enter fullscreen`
          : 'Waiting for target to enter fullscreen',
        detail: 'Enter fullscreen or change When to suppress in General.',
        diagnosticsLabel: 'Waiting for fullscreen',
        action: 'Enter fullscreen or change When to suppress in General.',
        needsAttention: true,
      };
    case 'error':
      return {
        label: 'Could not suppress local shortcuts',
        detail: message,
        diagnosticsLabel: 'Suppression failed',
        action:
          message === 'No writable shortcut settings were found'
            ? 'Review shortcut groups and exceptions in Shortcuts, then retry.'
            : 'Review Warnings below, then leave and refocus the target window.',
        needsAttention: true,
      };
    case 'recovery-pending':
      return {
        label: 'Shortcut recovery required',
        detail: message,
        diagnosticsLabel: 'Recovery required',
        action:
          'Restart GNOME Shell, or sign out and back in. Then reopen Diagnostics to confirm recovery.',
        needsAttention: true,
      };
    case 'inactive':
      return {
        label: 'Local shortcuts available',
        detail: message,
        diagnosticsLabel: 'Inactive',
        action: '',
        needsAttention: false,
      };
    case 'disabled':
      return {
        label: 'Shortcut suppression disabled',
        detail: message,
        diagnosticsLabel: 'Disabled',
        action: '',
        needsAttention: false,
      };
    default:
      return {
        label: 'Shortcut suppression status unavailable',
        detail: message,
        diagnosticsLabel: 'Unknown',
        action: 'Close and reopen Preferences. If this continues, copy Diagnostics.',
        needsAttention: true,
      };
  }
}

export function allowsCapture(scope, isFullscreen) {
  return scope !== 'fullscreen' || isFullscreen === true;
}

export function captureDecision({
  automatic,
  matchedRule,
  manualRule,
  scopeAllows,
  suspended,
}) {
  const rule = manualRule ?? (automatic ? matchedRule : null);
  return {
    activate: Boolean(rule && scopeAllows && !suspended),
    waiting: Boolean(rule && !scopeAllows && !suspended),
    rule,
  };
}

export function matchesRule(windowInfo, rule) {
  if (!windowInfo || !rule || rule.enabled === false) return false;
  if (windowInfo.isDialog && !rule.includeDialogs) return false;

  const identityMatches = IDENTITY_FIELDS.some((field) => {
    const expected = rule.identities?.[field];
    return (
      typeof expected === 'string' &&
      expected.length > 0 &&
      expected.toLowerCase() === String(windowInfo[field] ?? '').toLowerCase()
    );
  });
  if (!identityMatches) return false;

  const pattern = rule.titlePattern ?? '';
  if (rule.titleMode === 'contains')
    return (
      windowInfo.title?.toLowerCase().includes(pattern.toLowerCase()) ?? false
    );
  if (rule.titleMode === 'regex')
    return new RegExp(pattern, 'i').test(windowInfo.title ?? '');

  return true;
}

export function parseRules(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { rules: [], errors: [`Invalid rules JSON: ${error.message}`] };
  }

  if (!Array.isArray(parsed))
    return { rules: [], errors: ['Rules must be an array'] };

  const rules = [];
  const errors = [];
  for (const [index, rule] of parsed.entries()) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof rule.id !== 'string' ||
      rule.id.length === 0 ||
      (rule.name !== undefined && typeof rule.name !== 'string') ||
      (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') ||
      (rule.includeDialogs !== undefined &&
        typeof rule.includeDialogs !== 'boolean') ||
      (rule.titlePattern !== undefined &&
        typeof rule.titlePattern !== 'string') ||
      IDENTITY_FIELDS.some(
        (field) =>
          rule.identities?.[field] !== undefined &&
          typeof rule.identities[field] !== 'string',
      ) ||
      !IDENTITY_FIELDS.some(
        (field) =>
          typeof rule.identities?.[field] === 'string' &&
          rule.identities[field].length > 0,
      )
    ) {
      errors.push(`Rule ${index + 1} has invalid fields or no stable identity`);
      continue;
    }

    if (!['any', 'contains', 'regex'].includes(rule.titleMode)) {
      errors.push(`Rule ${index + 1} has an invalid title mode`);
      continue;
    }

    if (rule.titleMode === 'regex') {
      try {
        new RegExp(rule.titlePattern ?? '', 'i');
      } catch (error) {
        errors.push(`Rule ${index + 1} has an invalid regular expression`);
        continue;
      }
    }

    rules.push(rule);
  }

  return { rules, errors };
}

export function removeRuleById(rules, id) {
  return rules.filter((rule) => rule.id !== id);
}

export function restoreRuleAt(rules, rule, index) {
  if (rules.some((candidate) => candidate.id === rule.id)) return rules;
  const restored = [...rules];
  restored.splice(Math.max(0, Math.min(index, restored.length)), 0, rule);
  return restored;
}

export function bindingCategory(schemaId, key) {
  if (schemaId === 'org.gnome.shell.keybindings') {
    if (key.startsWith('screen-brightness-')) return 'hardware';
    if (key.includes('screenshot') || key === 'show-screen-recording-ui')
      return 'screenshot';
    return null;
  }

  if (
    schemaId === 'org.gnome.mutter.wayland.keybindings' &&
    /^switch-to-session-[1-9]\d*$/.test(key)
  )
    return 'power';

  if (schemaId !== 'org.gnome.settings-daemon.plugins.media-keys') return null;

  if (
    /^(screenreader|on-screen-keyboard|increase-text-size|decrease-text-size|toggle-contrast|magnifier)/.test(
      key,
    )
  )
    return 'accessibility';
  if (
    /^(power|hibernate|suspend|logout|reboot|shutdown|screensaver)(-static)?$/.test(
      key,
    )
  )
    return 'power';
  if (
    /^(eject|media|next|pause|play|previous|stop|volume-|mic-mute|touchpad-|playback-|rotate-video-lock|keyboard-brightness-|battery-status|rfkill)/.test(
      key,
    )
  )
    return 'hardware';

  return null;
}

export function serializeJournal(entries) {
  return JSON.stringify(entries);
}

export function parseJournal(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      entries: [],
      errors: [`Invalid recovery journal: ${error.message}`],
    };
  }

  if (!Array.isArray(parsed))
    return { entries: [], errors: ['Recovery journal must be an array'] };

  const entries = parsed.filter((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.schemaId !== 'string' ||
      entry.schemaId.length === 0 ||
      typeof entry.key !== 'string' ||
      entry.key.length === 0 ||
      !['s', 'as'].includes(entry.type) ||
      typeof entry.hadUserValue !== 'boolean'
    )
      return false;

    const isValue = (value) =>
      entry.type === 's'
        ? typeof value === 'string'
        : Array.isArray(value) &&
          value.every((item) => typeof item === 'string');
    return isValue(entry.originalValue) && isValue(entry.suppressedValue);
  });

  return {
    entries,
    errors:
      entries.length === parsed.length
        ? []
        : ['Some recovery entries were invalid'],
  };
}

export function shouldRestore(currentValue, suppressedValue) {
  return JSON.stringify(currentValue) === JSON.stringify(suppressedValue);
}

export function shouldResumeRuntimeRecovery(state, shellInstanceId) {
  return (
    state?.runtimeRecoveryPending === true &&
    state.shellInstanceId === shellInstanceId
  );
}

export function isRecoveryPending(runtime, journal, active = false) {
  return (
    runtime?.status === 'recovery-pending' ||
    runtime?.runtimeRecoveryPending === true ||
    (!active && journal !== '[]')
  );
}

const EXTERNAL_GRAB_NAME = /^external-grab-[1-9]\d*$/;

export function selectRuntimeGrabs(allowedKeybindings, noneMode) {
  if (!allowedKeybindings || typeof allowedKeybindings !== 'object') return [];

  const grabs = [];
  for (const [name, modes] of Object.entries(allowedKeybindings)) {
    if (!EXTERNAL_GRAB_NAME.test(name) || !Number.isInteger(modes)) continue;
    if (modes === noneMode) continue;
    grabs.push({ name, modes });
  }
  return grabs;
}

export function parseSelectedBindings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      items: [],
      errors: [`Invalid extension binding selection: ${error.message}`],
    };
  }

  if (!Array.isArray(parsed))
    return {
      items: [],
      errors: ['Extension binding selection must be an array'],
    };

  const items = parsed
    .filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        ['uuid', 'schemaId', 'key'].every(
          (property) =>
            typeof item[property] === 'string' && item[property].length > 0,
        ),
    )
    .map(({ uuid, schemaId, key }) => ({ uuid, schemaId, key }));

  return {
    items,
    errors:
      items.length === parsed.length
        ? []
        : ['Some extension binding selections were invalid'],
  };
}

export function redactRuntimeState(state) {
  const redactWindow = (windowInfo) => {
    if (!windowInfo || typeof windowInfo !== 'object') return windowInfo;
    const { title: _title, ...redacted } = windowInfo;
    return redacted;
  };

  return {
    ...state,
    focusedWindow: redactWindow(state.focusedWindow),
    recentWindows: Array.isArray(state.recentWindows)
      ? state.recentWindows.map(redactWindow)
      : [],
  };
}
