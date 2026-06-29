export class UnsupportedFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFeatureError";
  }
}
