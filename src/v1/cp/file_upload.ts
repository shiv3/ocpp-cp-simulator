export const UploadFile = async (url: string, file: File) => {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(url, {
    method: "POST",
    body: formData,
  });
  return response;
};
