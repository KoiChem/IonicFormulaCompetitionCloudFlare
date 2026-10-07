export type NicknameRequest = {
  readonly requestId: string;
  readonly expectedParticipantRevision: number;
  readonly nickname: string;
};

export function prepareNicknameRequest(
  pending: NicknameRequest | null,
  revision: number,
  nickname: string,
  requestId: () => string = () => crypto.randomUUID(),
): NicknameRequest {
  if (pending?.expectedParticipantRevision === revision && pending.nickname === nickname) return pending;
  return { requestId: requestId(), expectedParticipantRevision: revision, nickname };
}
