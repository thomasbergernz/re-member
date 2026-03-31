import type { APIRoute } from "astro";
import crypto from "node:crypto";
import * as Sentry from "@sentry/node";
import {
  createApplicantRow,
  getUploadStatus,
  getApplicantByToken,
  getApplicantByEmail,
  REQUIRED_DOC_TYPES,
} from "../../../lib/upload-sheet";
import { sendResumeLink } from "../../../lib/email-sender";
import { logger } from "../../../lib/logger";
import { getSiteBaseUrl } from "../../../lib/stripe-checkout";

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get("token");

  if (!token) {
    return Response.json({ status: "new" });
  }

  try {
    const applicant = await getApplicantByToken(token);

    if (!applicant) {
      return Response.json({ status: "new", error: "Invalid or expired link" });
    }

    if (applicant.paid) {
      return Response.json({
        status: "paid",
        firstName: applicant.firstName,
        lastName: applicant.lastName,
      });
    }

    const uploadStatus = await getUploadStatus(applicant.id);

    if (!uploadStatus) {
      return Response.json({ status: "error", error: "Application not found" });
    }

    const docsUploaded = REQUIRED_DOC_TYPES.filter(
      (type) => uploadStatus.docs[type]
    );

    const remaining = REQUIRED_DOC_TYPES.filter(
      (type) => !uploadStatus.docs[type]
    );

    return Response.json({
      status: docsUploaded.length === 7 ? "complete" : "partial",
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      docsUploaded,
      remaining,
      complete: uploadStatus.complete,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Sentry.captureException(error, { extra: { token } });
    logger.error("resume_link_load_failed", {
      token,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return Response.json(
      { status: "error", error: "Failed to load application. Please try again." },
      { status: 500 }
    );
  }
};

export const POST: APIRoute = async ({ request, url }) => {
  let payload: { firstName?: string; lastName?: string; phone?: string; email?: string };

  try {
    payload = (await request.json()) as { firstName?: string; lastName?: string; phone?: string; email?: string };
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const firstName = payload.firstName?.trim();
  const lastName = payload.lastName?.trim();
  const phone = payload.phone?.trim();
  const email = payload.email?.trim().toLowerCase();

  if (!firstName) {
    return Response.json({ error: "First name is required." }, { status: 400 });
  }

  if (!lastName) {
    return Response.json({ error: "Last name is required." }, { status: 400 });
  }

  if (!email) {
    return Response.json({ error: "Email is required." }, { status: 400 });
  }

  // Basic email validation
  if (!email.includes("@") || !email.includes(".")) {
    return Response.json({ error: "Valid email is required." }, { status: 400 });
  }

  const fullName = `${firstName} ${lastName}`;

  try {
    // Check if email already exists
    const existingApplicant = await getApplicantByEmail(email);
    if (existingApplicant) {
      const siteBaseUrl = getSiteBaseUrl(url.href);
      const resumeLink = `${siteBaseUrl}/professional/apply?token=${existingApplicant.resumeToken}`;
      return Response.json({
        success: true,
        resumeLink,
        applicantId: existingApplicant.id,
        existing: true,
      });
    }

    // Generate applicant ID and resume token
    const applicantId = crypto.randomUUID();
    const resumeToken = crypto.randomUUID();

    // Create row in Google Sheet with all info
    await createApplicantRow(applicantId, firstName, lastName, phone, email, resumeToken);

    // Build resume link
    const siteBaseUrl = getSiteBaseUrl(url.href);
    const resumeLink = `${siteBaseUrl}/professional/apply?token=${resumeToken}`;

    // Send email with resume link
    try {
      await sendResumeLink(email, fullName, resumeLink);
      logger.info("resume_email_sent", { applicantId, email });
    } catch (emailError) {
      // Log but don't fail - show link on-screen instead
      logger.error("resume_email_failed", {
        applicantId,
        email,
        error: emailError instanceof Error ? emailError.message : "Unknown",
      });
      Sentry.captureMessage("Failed to send resume email", {
        extra: { applicantId, email },
      });
    }

    return Response.json({
      success: true,
      resumeLink,
      applicantId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Sentry.captureException(error, { extra: { email, fullName } });
    logger.error("applicant_registration_failed", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return Response.json(
      { error: "Failed to create application. Please try again." },
      { status: 500 }
    );
  }
};