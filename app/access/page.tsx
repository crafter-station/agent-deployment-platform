import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

export default function AccessPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <section style={{ maxWidth: 460 }}>
        <p>Quequito Studio</p>
        <h1>Esta cuenta todavía no tiene acceso.</h1>
        <p>
          El estudio está disponible para las cuentas habilitadas del piloto.
          Puedes cambiar de cuenta desde este menú.
        </p>
        <UserButton />
        <p>
          <Link href="/">Volver a intentar</Link>
        </p>
      </section>
    </main>
  );
}
