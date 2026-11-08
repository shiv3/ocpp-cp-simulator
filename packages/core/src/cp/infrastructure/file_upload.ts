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
