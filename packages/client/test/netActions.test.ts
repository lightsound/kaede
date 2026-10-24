import type { PlannedSend } from '@kaede/shared';
import { Identity } from 'spacetimedb';
import { describe, expect, it, vi } from 'vitest';
import { type Net, planChatDraftOffline, type SpaceMemberView } from '../src/net.package';
import { netActionsOf } from '../src/netActions';

type Actions = ReturnType<typeof netActionsOf>;

const RECORDINGS = [{ fileName: 'rec.mp4', size: 2048, uploadedAt: '2026-10-24T00:00:00.000Z' }];

/** A Net whose every method is a spy; the procedure calls resolve to distinctive answers. */
function fakeNet() {
  return {
    dispose: vi.fn(),
    setDisplayName: vi.fn(),
    applyForMembership: vi.fn(),
    memberAction: vi.fn(),
    setGuestsAllowed: vi.fn(),
    planChatSend: vi.fn(
      (draft: string): PlannedSend => ({ kind: 'public', text: `planned ${draft}` }),
    ),
    sendPlanned: vi.fn(),
    sendAnnouncement: vi.fn(),
    sendReaction: vi.fn(),
    playGesture: vi.fn(),
    setAvailability: vi.fn(),
    setStatusText: vi.fn(),
    createZone: vi.fn(),
    updateZone: vi.fn(),
    moveZone: vi.fn(),
    deleteZone: vi.fn(),
    createHuddle: vi.fn(),
    joinHuddle: vi.fn(),
    leaveHuddle: vi.fn(),
    joinGroupCall: vi.fn(() => Promise.resolve({ groupId: 1n, authToken: 'token' })),
    startGroupRecording: vi.fn(() => Promise.resolve()),
    stopGroupRecording: vi.fn(() => Promise.resolve()),
    listRecordings: vi.fn(() => Promise.resolve(RECORDINGS)),
    recordingDownloadUrl: vi.fn(() => Promise.resolve('https://example.test/rec.mp4')),
  } satisfies Net;
}

const MEMBER: SpaceMemberView = {
  identity: Identity.zero(),
  idHex: '00',
  displayName: 'かえで',
  status: 'pending',
  role: 'member',
  requestedAtMs: 0,
};
const PLAN: PlannedSend = { kind: 'public', text: 'こんにちは' };
const HUDDLE = { name: '雑談', closed: false };
const ZONE = { name: '会議室', closed: true };
const EDIT = { name: '会議室', closed: true, w: 200, h: 120 };
const NOT_CONNECTED = 'SpacetimeDB: not connected';

/** One surface command, the one Net method it must reach, and the arguments that method must see. */
interface Wiring {
  command: string;
  invoke: (actions: Actions) => unknown;
  method: keyof Net;
  args: unknown[];
}

const REDUCER_COMMANDS: Wiring[] = [
  {
    command: 'applyForMembership',
    invoke: (a) => a.applyForMembership(),
    method: 'applyForMembership',
    args: [],
  },
  {
    command: 'setDisplayName',
    invoke: (a) => a.setDisplayName('かえで'),
    method: 'setDisplayName',
    args: ['かえで'],
  },
  {
    command: 'setAvailability',
    invoke: (a) => a.setAvailability('away'),
    method: 'setAvailability',
    args: ['away'],
  },
  {
    command: 'setStatusText',
    invoke: (a) => a.setStatusText('会議中'),
    method: 'setStatusText',
    args: ['会議中'],
  },
  {
    command: 'huddle.onCreateHuddle',
    invoke: (a) => a.huddle.onCreateHuddle(HUDDLE),
    method: 'createHuddle',
    args: [HUDDLE],
  },
  {
    command: 'huddle.onJoinHuddle',
    invoke: (a) => a.huddle.onJoinHuddle(3n),
    method: 'joinHuddle',
    args: [3n],
  },
  {
    command: 'huddle.onLeaveHuddle',
    invoke: (a) => a.huddle.onLeaveHuddle(),
    method: 'leaveHuddle',
    args: [],
  },
  {
    command: 'zones.onCreateZone',
    invoke: (a) => a.zones.onCreateZone(ZONE),
    method: 'createZone',
    args: [ZONE],
  },
  {
    command: 'zones.onUpdateZone',
    invoke: (a) => a.zones.onUpdateZone(7n, EDIT),
    method: 'updateZone',
    args: [{ zoneId: 7n, ...EDIT }],
  },
  {
    command: 'zones.onMoveZone',
    invoke: (a) => a.zones.onMoveZone(8n),
    method: 'moveZone',
    args: [8n],
  },
  {
    command: 'zones.onDeleteZone',
    invoke: (a) => a.zones.onDeleteZone(9n),
    method: 'deleteZone',
    args: [9n],
  },
  {
    command: 'memberAction',
    invoke: (a) => a.memberAction('ban', MEMBER),
    method: 'memberAction',
    args: ['ban', MEMBER.identity],
  },
  {
    command: 'setGuestsAllowed',
    invoke: (a) => a.setGuestsAllowed(false),
    method: 'setGuestsAllowed',
    args: [false],
  },
  {
    command: 'sendAnnouncement',
    invoke: (a) => a.sendAnnouncement('お知らせ'),
    method: 'sendAnnouncement',
    args: ['お知らせ'],
  },
  {
    command: 'sendPlanned',
    invoke: (a) => a.sendPlanned(PLAN, 'space'),
    method: 'sendPlanned',
    args: [PLAN, 'space'],
  },
  {
    command: 'sendReaction',
    invoke: (a) => a.sendReaction('🎉'),
    method: 'sendReaction',
    args: ['🎉'],
  },
  {
    command: 'playGesture',
    invoke: (a) => a.playGesture('wave'),
    method: 'playGesture',
    args: ['wave'],
  },
];

const PROCEDURE_CALLS: Wiring[] = [
  {
    command: 'call.joinGroupCall',
    invoke: (a) => a.call.joinGroupCall(),
    method: 'joinGroupCall',
    args: [],
  },
  {
    command: 'call.startGroupRecording',
    invoke: (a) => a.call.startGroupRecording(2n),
    method: 'startGroupRecording',
    args: [2n],
  },
  {
    command: 'call.stopGroupRecording',
    invoke: (a) => a.call.stopGroupRecording(2n),
    method: 'stopGroupRecording',
    args: [2n],
  },
  {
    command: 'call.listRecordings',
    invoke: (a) => a.call.listRecordings(),
    method: 'listRecordings',
    args: [],
  },
  {
    command: 'call.recordingDownloadUrl',
    invoke: (a) => a.call.recordingDownloadUrl('rec.mp4'),
    method: 'recordingDownloadUrl',
    args: ['rec.mp4'],
  },
];

const PLANNER: Wiring = {
  command: 'planChatSend',
  invoke: (a) => a.planChatSend('やあ'),
  method: 'planChatSend',
  args: ['やあ'],
};

describe('netActionsOf before the net stack is mounted', () => {
  it.each(REDUCER_COMMANDS)('drops $command without throwing', ({ invoke }) => {
    expect(invoke(netActionsOf({ current: undefined }, () => {}))).toBeUndefined();
  });

  it.each(PROCEDURE_CALLS)('rejects $command with the not-connected error', async ({ invoke }) => {
    await expect(invoke(netActionsOf({ current: undefined }, () => {}))).rejects.toThrow(
      NOT_CONNECTED,
    );
  });

  it('plans drafts with the no-session rule', () => {
    const { planChatSend } = netActionsOf({ current: undefined }, () => {});
    for (const draft of ['こんにちは', '@かえで やあ']) {
      expect(planChatSend(draft)).toEqual(planChatDraftOffline(draft));
    }
  });

  it('still clears the refused trace on a chat send', () => {
    const onChatSend = vi.fn();
    netActionsOf({ current: undefined }, onChatSend).sendPlanned(PLAN, 'space');
    expect(onChatSend).toHaveBeenCalledOnce();
  });
});

describe('netActionsOf once mounted', () => {
  // Each command runs against a fresh Net, so one wired to the wrong method
  // fails even when that method takes the same arguments (or none).
  it.each([...REDUCER_COMMANDS, ...PROCEDURE_CALLS, PLANNER])(
    '$command reaches Net.$method alone, with what the surface passed adapted',
    ({ invoke, method, args }) => {
      const net = fakeNet();
      invoke(netActionsOf({ current: net }, () => {}));
      for (const [name, spy] of Object.entries(net)) {
        if (name === method) expect(spy, name).toHaveBeenCalledExactlyOnceWith(...args);
        else expect(spy, name).not.toHaveBeenCalled();
      }
    },
  );

  it("hands back the Net's answers to the procedure calls and the planner", async () => {
    const { call, planChatSend } = netActionsOf({ current: fakeNet() }, () => {});
    await expect(call.joinGroupCall()).resolves.toEqual({ groupId: 1n, authToken: 'token' });
    await expect(call.startGroupRecording(2n)).resolves.toBeUndefined();
    await expect(call.stopGroupRecording(2n)).resolves.toBeUndefined();
    await expect(call.listRecordings()).resolves.toBe(RECORDINGS);
    await expect(call.recordingDownloadUrl('rec.mp4')).resolves.toBe(
      'https://example.test/rec.mp4',
    );
    expect(planChatSend('やあ')).toEqual({ kind: 'public', text: 'planned やあ' });
  });

  it('clears the refused trace before sending the plan', () => {
    const order: string[] = [];
    const net = fakeNet();
    net.sendPlanned.mockImplementation(() => order.push('send'));
    netActionsOf({ current: net }, () => order.push('clear')).sendPlanned(PLAN, 'space');
    expect(order).toEqual(['clear', 'send']);
    expect(net.sendPlanned).toHaveBeenCalledWith(PLAN, 'space');
  });

  it('reads the handle at call time, not when the actions were built', () => {
    const net = fakeNet();
    const ref: { current: Net | undefined } = { current: undefined };
    const actions = netActionsOf(ref, () => {});
    // The mount finishes after the render that built the actions...
    ref.current = net;
    actions.setDisplayName('かえで');
    // ...and the effect's cleanup disposes the stack before the next render.
    ref.current = undefined;
    actions.setDisplayName('もみじ');
    expect(net.setDisplayName).toHaveBeenCalledTimes(1);
    expect(net.setDisplayName).toHaveBeenCalledWith('かえで');
  });
});
