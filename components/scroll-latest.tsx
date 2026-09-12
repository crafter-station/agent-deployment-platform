"use client";

export default function ScrollLatest() {
  return (
    <button
      type="button"
      className="scroll-latest"
      onClick={(event) => {
        const region = event.currentTarget.parentElement;
        region?.scrollTo({ top: region.scrollHeight, behavior: "smooth" });
      }}
    >
      Ir al último mensaje
    </button>
  );
}
