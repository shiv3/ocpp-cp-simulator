/**
 * Uploads a file to a URL the CSMS gave (GetDiagnostics, #575): a multipart
 * POST by default (`infrastructure/fileUpload`'s `UploadFile`). The
 * diagnostics behavior in `application/engine` reaches it through
 * `ChargePoint.fileUploader` and reads only `ok` and `status`.
 */
export type FileUploader = (
  url: string,
  file: File,
  signal?: AbortSignal,
) => Promise<{ readonly ok: boolean; readonly status: number }>;
