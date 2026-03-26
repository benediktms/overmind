export class OvermindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OvermindError";
  }
}

export class BrainError extends OvermindError {
  constructor(message: string) {
    super(message);
    this.name = "BrainError";
  }
}

export class NeuralLinkError extends OvermindError {
  constructor(message: string) {
    super(message);
    this.name = "NeuralLinkError";
  }
}

export class AdapterError extends OvermindError {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}
