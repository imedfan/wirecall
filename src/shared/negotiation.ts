export type SignalingState = "stable" | "have-local-offer" | "have-remote-offer" | "have-local-pranswer" | "have-remote-pranswer" | "closed";

export function offerCollides(makingOffer: boolean, signalingState: SignalingState): boolean {
  return makingOffer || signalingState !== "stable";
}

export function shouldCreateOffer(input: { polite: boolean; iceRestart: boolean }): boolean {
  // The polite peer answers. A simultaneous initial offer rolls back gathering and can leave ICE in "new".
  return !input.polite || input.iceRestart;
}

export function shouldIgnoreOffer(input: {
  polite: boolean;
  makingOffer: boolean;
  signalingState: SignalingState;
  descriptionType: "offer" | "answer";
}): boolean {
  if (input.descriptionType !== "offer") return false;
  return !input.polite && offerCollides(input.makingOffer, input.signalingState);
}
