import { NextResponse } from "next/server";
import { sign } from "@/lib/security/tokens";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const PROOF_TTL_SECONDS = 15 * 60; // 15 minutes

export async function POST(request: Request) {
  const secret = (process.env.TURNSTILE_SECRET_KEY || "").trim();

  // If Turnstile secret is not configured on the server, issue a bypass proof
  // so local development without Turnstile keys continues working seamlessly.
  if (!secret) {
    const proof = sign({ k: "turnstile", bypass: true }, PROOF_TTL_SECONDS);
    return NextResponse.json({
      success: true,
      bypass: true,
      proof,
      expiresAt: Date.now() + PROOF_TTL_SECONDS * 1000,
    });
  }

  let token = "";
  try {
    const body = (await request.json()) as { token?: string };
    token = typeof body?.token === "string" ? body.token.trim() : "";
  } catch {
    return NextResponse.json(
      { success: false, error: "INVALID_REQUEST" },
      { status: 400 }
    );
  }

  if (!token) {
    return NextResponse.json(
      { success: false, error: "MISSING_TOKEN" },
      { status: 400 }
    );
  }

  const forwarded = request.headers.get("x-forwarded-for") || "";
  const remoteIp = forwarded.split(",")[0].trim();

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp && remoteIp !== "127.0.0.1" && remoteIp !== "::1") {
    form.set("remoteip", remoteIp);
  }

  try {
    const verifyRes = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
    });

    if (!verifyRes.ok) {
      return NextResponse.json(
        { success: false, error: `SITEVERIFY_HTTP_${verifyRes.status}` },
        { status: 502 }
      );
    }

    const data = (await verifyRes.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };

    if (!data?.success) {
      return NextResponse.json(
        {
          success: false,
          error: "TURNSTILE_FAILED",
          codes: data?.["error-codes"] || [],
        },
        { status: 403 }
      );
    }

    const expiresAt = Date.now() + PROOF_TTL_SECONDS * 1000;
    const proof = sign({ k: "turnstile" }, PROOF_TTL_SECONDS);

    const response = NextResponse.json({ success: true, proof, expiresAt });
    response.cookies.set("gembed_ts_proof", proof, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: PROOF_TTL_SECONDS,
    });
    return response;
  } catch {
    return NextResponse.json(
      { success: false, error: "VERIFY_ERROR" },
      { status: 500 }
    );
  }
}
