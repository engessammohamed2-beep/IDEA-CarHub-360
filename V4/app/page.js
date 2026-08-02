import { redirect } from "next/navigation";

// Owner Mode: single entry point for everyone (admin + clients).
// The license's Role column decides what the logged-in user can see.
export default function Home() {
  redirect("/client/login");
}
