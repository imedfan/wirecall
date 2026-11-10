export type SignalingState = "stable" | "have-local-offer" | "have-remote-offer" | "have-local-pranswer" | "have-remote-pranswer" | "closed";

export function offerCollides(makingOffer: boolean, signalingState: SignalingState): boolean {
  return makingOffer || signalingState !== "stable";
}

export function shouldCreateOffer(input: { polite: boolean }): boolean {
  // Only the impolite peer offers, including after an ICE restart. A second offer rolls back gathering.
  return !input.polite;
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
