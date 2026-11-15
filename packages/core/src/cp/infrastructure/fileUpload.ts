export const UploadFile = async (
  url: string,
  file: File,
  signal?: AbortSignal,
) => {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(url, {
    method: "POST",
    body: formData,
    ...(signal ? { signal } : {}),
  });
  return response;
};

/**
 * The GetLog upload (#926): the file as the raw body of an HTTP PUT to the
 * URL the CSMS gave, with the file name in `Content-Disposition`. Not the
 * multipart POST of {@link UploadFile} (GetDiagnostics): an OCPP log is stored
 * at a location, so the request body is the file. Redirects are not followed
 * (a 3xx is a failed attempt), so a CSMS cannot bounce the station to an
 * address the URL check refused.
 */
export const PutFile = async (
  url: string,
  file: File,
  signal?: AbortSignal,
) => {
  const response = await fetch(url, {
    method: "PUT",
    body: file,
    redirect: "manual",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.name.replace(/[^\w.-]/g, "_")}"`,
    },
    ...(signal ? { signal } : {}),
  });
  return response;
};
