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
  preferredWindowIdentity,
  redactRuntimeState,
  removeRuleById,
  restoreRuleAt,
  selectRuntimeGrabs,
  serializeJournal,
  shouldResumeRuntimeRecovery,
  shouldRestore,
} from '../core.js';

function assertEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson)
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
}

assertEqual(
  normalizeAccelerator('<Ctrl><Shift>grave'),
  '<Shift><Primary>grave',
  'normalizes aliases and modifier order',
);

assertEqual(
  normalizeAccelerator('<SHIFT><CONTROL>GRAVE'),
  '<Shift><Primary>grave',
  'normalization is case insensitive',
);

assertEqual(
  filterAccelerators(
    ['<Super>w', '<Control><Alt>Escape'],
    ['<Alt><Primary>Escape'],
  ),
  ['<Control><Alt>Escape'],
  'keeps only local exceptions from a binding array',
);

assertEqual(
  filterAccelerators(['<Super>w'], []),
  [],
  'suppresses every binding without exceptions',
);

const rustDeskWindow = {
  appId: 'com.rustdesk.RustDesk.desktop',
  gtkAppId: '',
  sandboxedAppId: '',
  wmClass: 'rustdesk',
  wmClassInstance: 'rustdesk',
  title: 'Workstation',
  isNormal: true,
  isDialog: false,
};

const rule = {
  id: 'lab',
  name: 'Lab viewer',
  enabled: true,
  identities: { wmClass: 'RemoteViewer' },
  titleMode: 'contains',
  titlePattern: 'session 4',
  includeDialogs: false,
};

assertEqual(
  matchesRule(
    { ...rustDeskWindow, wmClass: 'remoteviewer', title: 'SESSION 42' },
    rule,
  ),
  true,
  'custom rule combines exact identity and case-insensitive title match',
);
assertEqual(
  matchesRule(
    { ...rustDeskWindow, wmClass: 'remoteviewer', title: 'Other host' },
    rule,
  ),
  false,
  'custom rule requires its title condition',
);
assertEqual(
  matchesRule(
    {
      ...rustDeskWindow,
      wmClass: 'remoteviewer',
      title: 'Session 42',
      isDialog: true,
    },
    rule,
  ),
  false,
  'custom rule excludes dialogs unless selected',
);
assertEqual(
  matchesRule(
    {
      ...rustDeskWindow,
      wmClass: 'remoteviewer',
      title: 'Session 42',
      isDialog: true,
    },
    { ...rule, includeDialogs: true },
  ),
  true,
  'custom rule may include dialogs',
);
assertEqual(
  matchesRule(
    { ...rustDeskWindow, wmClass: 'remoteviewer', title: 'Server 42' },
    { ...rule, titleMode: 'regex', titlePattern: '^server \\d+$' },
  ),
  true,
  'custom rule supports case-insensitive regular expressions',
);

assertEqual(
  parseRules(JSON.stringify([rule])).rules,
  [rule],
  'valid rules survive parsing',
);
assertEqual(
  parseRules('[{"identities":{},"titleMode":"any"}]').rules,
  [],
  'rules require a stable identity',
);
assertEqual(
  parseRules(
    '[{"identities":{"appId":"viewer"},"titleMode":"regex","titlePattern":"["}]',
  ).rules,
  [],
  'invalid regular expressions are skipped',
);
assertEqual(
  parseRules(
    '[{"id":"bad","identities":{"appId":"viewer"},"titleMode":"contains","titlePattern":42}]',
  ).rules,
  [],
  'rules reject non-string title patterns',
);
assertEqual(
  parseRules(
    '[{"id":"bad","identities":{"appId":"viewer"},"titleMode":"any","includeDialogs":"yes"}]',
  ).rules,
  [],
  'rules reject non-boolean dialog flags',
);
assertEqual(
  parseRules('not json').errors.length,
  1,
  'invalid rule JSON is reported',
);
const otherRule = { ...rule, id: 'backup', name: 'Backup viewer' };
assertEqual(
  removeRuleById([rule, otherRule], rule.id),
  [otherRule],
  'rule deletion removes only the selected rule',
);
assertEqual(
  restoreRuleAt([otherRule], rule, 0),
  [rule, otherRule],
  'rule undo restores the original position',
);
assertEqual(
  restoreRuleAt([rule, otherRule], rule, 1),
  [rule, otherRule],
  'rule undo does not duplicate an existing rule',
);
assertEqual(
  shouldResumeRuntimeRecovery(
    { shellInstanceId: 'shell-1', runtimeRecoveryPending: true },
    'shell-1',
  ),
  true,
  'runtime recovery survives an extension toggle in the same Shell',
);
assertEqual(
  shouldResumeRuntimeRecovery(
    { shellInstanceId: 'shell-1', runtimeRecoveryPending: true },
    'shell-2',
  ),
  false,
  'a Shell restart clears runtime-only recovery',
);
assertEqual(
  isRecoveryPending(
    { status: 'waiting', runtimeRecoveryPending: true },
    '[]',
  ),
  true,
  'runtime recovery takes precedence over a waiting status',
);
assertEqual(
  isRecoveryPending({ status: 'inactive' }, '[]'),
  false,
  'normal inactive state has no pending recovery',
);
assertEqual(
  isRecoveryPending({ status: 'captured' }, '[{"pending":true}]', true),
  false,
  'an active suppression journal is not a recovery failure',
);

assertEqual(
  bindingCategory(
    'org.gnome.settings-daemon.plugins.media-keys',
    'volume-up-static',
  ),
  'hardware',
  'classifies media hardware keys',
);
assertEqual(
  bindingCategory('org.gnome.shell.keybindings', 'screen-brightness-down'),
  'hardware',
  'classifies Shell brightness keys',
);
assertEqual(
  bindingCategory(
    'org.gnome.settings-daemon.plugins.media-keys',
    'screensaver',
  ),
  'power',
  'classifies lock-screen keys',
);
assertEqual(
  bindingCategory(
    'org.gnome.settings-daemon.plugins.media-keys',
    'magnifier-zoom-in',
  ),
  'accessibility',
  'classifies accessibility keys',
);
assertEqual(
  bindingCategory('org.gnome.shell.keybindings', 'show-screenshot-ui'),
  'screenshot',
  'classifies screenshot keys',
);
assertEqual(
  bindingCategory('org.gnome.settings-daemon.plugins.media-keys', 'terminal'),
  null,
  'leaves application launch keys uncategorized',
);
assertEqual(
  bindingCategory(
    'org.gnome.mutter.wayland.keybindings',
    'switch-to-session-12',
  ),
  'power',
  'classifies virtual terminal switches with power and lock keys',
);
assertEqual(
  bindingCategory('org.gnome.desktop.wm.keybindings', 'switch-to-session-1'),
  null,
  'virtual terminal classification stays on the wayland schema',
);
assertEqual(
  allowsCapture('focused', false),
  true,
  'focused capture does not require fullscreen',
);
assertEqual(
  allowsCapture('fullscreen', true),
  true,
  'fullscreen capture allows a fullscreen window',
);
assertEqual(
  allowsCapture('fullscreen', false),
  false,
  'fullscreen capture waits while the window is not fullscreen',
);
const manualRule = { id: 'manual', name: 'current window' };
assertEqual(
  captureDecision({
    automatic: false,
    matchedRule: null,
    manualRule,
    scopeAllows: false,
    suspended: false,
  }),
  { activate: false, waiting: true, rule: manualRule },
  'manual suppression waits for fullscreen without automatic rules',
);
assertEqual(
  captureDecision({
    automatic: false,
    matchedRule: null,
    manualRule,
    scopeAllows: true,
    suspended: false,
  }),
  { activate: true, waiting: false, rule: manualRule },
  'pending manual suppression starts after entering fullscreen',
);

assertEqual(
  preferredWindowIdentity(rustDeskWindow),
  { appId: 'com.rustdesk.RustDesk.desktop' },
  'recent windows use one stable identifier',
);
assertEqual(
  preferredWindowIdentity({
    appId: '',
    gtkAppId: '',
    sandboxedAppId: '',
    wmClass: '  remoteviewer  ',
    wmClassInstance: 'remoteviewer',
  }),
  { wmClass: 'remoteviewer' },
  'window identity falls back to WM class and trims it',
);

assertEqual(
  captureStatusPresentation({
    status: 'captured',
    matchedRule: { name: 'Lab viewer' },
    message: '',
  }),
  {
    label: 'Local shortcuts suppressed for Lab viewer',
    detail: '',
    diagnosticsLabel: 'Active',
    action: '',
    needsAttention: false,
  },
  'active status names the matched target',
);
assertEqual(
  captureStatusPresentation({
    status: 'waiting',
    matchedRule: { name: 'Lab viewer' },
    message: '',
  }),
  {
    label: 'Waiting for Lab viewer to enter fullscreen',
    detail: 'Enter fullscreen or change When to suppress in General.',
    diagnosticsLabel: 'Waiting for fullscreen',
    action: 'Enter fullscreen or change When to suppress in General.',
    needsAttention: true,
  },
  'waiting status explains the required action',
);
assertEqual(
  captureStatusPresentation({
    status: 'error',
    message: 'No writable shortcut settings were found',
  }),
  {
    label: 'Could not suppress local shortcuts',
    detail: 'No writable shortcut settings were found',
    diagnosticsLabel: 'Suppression failed',
    action: 'Review shortcut groups and exceptions in Shortcuts, then retry.',
    needsAttention: true,
  },
  'error status preserves the cause and gives a recovery step',
);
assertEqual(
  captureStatusPresentation({
    status: 'recovery-pending',
    message: 'Some shortcut settings still need recovery',
  }),
  {
    label: 'Shortcut recovery required',
    detail: 'Some shortcut settings still need recovery',
    diagnosticsLabel: 'Recovery required',
    action:
      'Restart GNOME Shell, or sign out and back in. Then reopen Diagnostics to confirm recovery.',
    needsAttention: true,
  },
  'recovery status gives an explicit next step',
);

const journal = [
  {
    source: 'default',
    schemaId: 'org.example.shortcuts',
    path: null,
    key: 'show',
    type: 'as',
    hadUserValue: false,
    originalValue: ['<Super>w'],
    suppressedValue: [],
  },
];
assertEqual(
  parseJournal(serializeJournal(journal)).entries,
  journal,
  'journal serialization preserves restore data',
);
assertEqual(
  parseJournal('{bad').entries,
  [],
  'invalid journal JSON is ignored safely',
);
assertEqual(
  parseJournal(
    JSON.stringify([
      {
        ...journal[0],
        originalValue: '<Super>w',
      },
    ]),
  ).entries,
  [],
  'journal values must match their recorded variant type',
);
assertEqual(
  shouldRestore([], []),
  true,
  'unchanged suppressed values may be restored',
);
assertEqual(
  shouldRestore(['<Super>x'], []),
  false,
  'external edits are not overwritten',
);

assertEqual(
  selectRuntimeGrabs(
    {
      'external-grab-3': 1,
      'external-grab-40': 7,
      'release-capture': 1,
      'switch-to-workspace-left': 3,
      'external-grab-': 1,
      'external-grab-0': 1,
      'external-grab-01': 1,
      'external-grab-2a': 1,
      'external-grab-9': '1',
      'external-grab-8': 0,
    },
    0,
  ),
  [
    { name: 'external-grab-3', modes: 1 },
    { name: 'external-grab-40', modes: 7 },
  ],
  'selects active external-grab-N bindings and keeps exact prior modes',
);
assertEqual(
  selectRuntimeGrabs({ 'external-grab-4': 1, 'external-grab-5': 4 }, 1),
  [{ name: 'external-grab-5', modes: 4 }],
  'already-disabled grabs match the provided none mode',
);
assertEqual(
  selectRuntimeGrabs(null, 0),
  [],
  'a missing runtime registry selects nothing',
);

assertEqual(
  parseSelectedBindings(
    JSON.stringify([
      {
        uuid: 'switcher@example',
        schemaId: 'org.example.switcher',
        key: 'show',
      },
      { uuid: '', schemaId: 'org.example.bad', key: 'show' },
    ]),
  ).items,
  [{ uuid: 'switcher@example', schemaId: 'org.example.switcher', key: 'show' }],
  'selected extension bindings require complete descriptors',
);

assertEqual(
  redactRuntimeState({
    focusedWindow: { appId: 'viewer.desktop', title: 'Secret host' },
    recentWindows: [{ wmClass: 'viewer', title: 'Another host' }],
    suppressed: [{ binding: '<Super>w' }],
  }).focusedWindow,
  { appId: 'viewer.desktop' },
  'diagnostic redaction removes focused-window titles',
);

print('core policy tests passed');
