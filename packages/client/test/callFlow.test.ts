import { describe, expect, it } from 'vitest';
import { acquireCallTicket, type CallFlowDeps } from '../src/call.package/flow';

const GROUP = 7n;
const REGISTERED = 'bbb8280d-7d30-430b-a3a0-78802ed5617c';
const PROVISIONED = 'aaa08ce1-92dd-48f7-a48b-169f86a34c08';

/** A deps double: every effect resolves, overridable per case. */
function makeDeps(overrides: Partial<CallFlowDeps> = {}): CallFlowDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ownGroupCall: () => ({ groupId: GROUP, meetingId: REGISTERED }),
    registerGroupCall: (id) => {
      calls.push(`register:${id}`);
      return Promise.resolve();
    },
    provisionMeeting: () => {
      calls.push('provision');
      return Promise.resolve(PROVISIONED);
    },
    mintToken: (id) => {
      calls.push(`mint:${id}`);
      return Promise.resolve(`token-for-${id}`);
    },
    delay: () => Promise.resolve(),
    ...overrides,
  };
}

describe('acquireCallTicket', () => {
  it('登録済みミーティングがあれば作成せずトークン発行だけ行う', async () => {
    const deps = makeDeps();
    const ticket = await acquireCallTicket(deps);
    expect(ticket).toEqual({
      groupId: GROUP,
      meetingId: REGISTERED,
      authToken: `token-for-${REGISTERED}`,
    });
    expect(deps.calls).toEqual([`mint:${REGISTERED}`]);
  });

  it('未登録なら作成→登録→発行の順で進む(通話開始)', async () => {
    const deps = makeDeps({ ownGroupCall: () => ({ groupId: GROUP, meetingId: undefined }) });
    const ticket = await acquireCallTicket(deps);
    expect(ticket.meetingId).toBe(PROVISIONED);
    expect(ticket.authToken).toBe(`token-for-${PROVISIONED}`);
    expect(deps.calls).toEqual(['provision', `register:${PROVISIONED}`, `mint:${PROVISIONED}`]);
  });

  it('登録競合に負けたら勝者の行を読み直して参加する', async () => {
    let meetingId: string | undefined;
    const deps = makeDeps({
      ownGroupCall: () => ({ groupId: GROUP, meetingId }),
      registerGroupCall: () => Promise.reject(new Error('already-registered')),
      delay: () => {
        // 敗者が待っている間に勝者の行が購読キャッシュへ届く
        meetingId = REGISTERED;
        return Promise.resolve();
      },
    });
    const ticket = await acquireCallTicket(deps);
    expect(ticket.authToken).toBe(`token-for-${REGISTERED}`);
  });

  it('会話グループに居なければ何も呼ばずに失敗する', async () => {
    const deps = makeDeps({ ownGroupCall: () => undefined });
    await expect(acquireCallTicket(deps)).rejects.toThrow('not in a conversation group');
    expect(deps.calls).toEqual([]);
  });

  it('登録中にグループを移っていたら古いラベルで参加せず失敗する', async () => {
    // 登録は成功する(サーバーは移動後のグループへ束縛した)が、チケットの
    // groupId が読み時点のグループを指したままでは auto-leave の監視が
    // 嘘をつくため、参加せずに失敗する(ユーザーはいまの場所から再試行)。
    let groupId = GROUP;
    const deps = makeDeps({
      ownGroupCall: () => ({ groupId, meetingId: undefined }),
      registerGroupCall: () => {
        groupId = 9n; // 呼び出しが着地する前に別グループへ移った
        return Promise.resolve();
      },
    });
    await expect(acquireCallTicket(deps)).rejects.toThrow('left the group mid-registration');
  });

  it('競合でもなくグループも変わっていたら元の拒否を伝える', async () => {
    let first = true;
    const deps = makeDeps({
      ownGroupCall: () => {
        if (first) {
          first = false;
          return { groupId: GROUP, meetingId: undefined };
        }
        return { groupId: 9n, meetingId: REGISTERED }; // 別グループへ移った
      },
      registerGroupCall: () => Promise.reject(new Error('not-in-a-group')),
    });
    await expect(acquireCallTicket(deps)).rejects.toThrow('not-in-a-group');
  });
});
