window.connection.read().then((url) => {
  document.getElementById("url").value = url;
});
document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await window.connection.save(document.getElementById("url").value.trim());
  } catch (error) {
    document.getElementById("error").textContent = error.message.replace(
      /^Error invoking remote method.*?: Error: /,
      "",
    );
  }
});
