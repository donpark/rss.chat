// email.js — Magic link confirmation email sending
// Tries Cloudflare Email Routing first (zero-config if domain is on Cloudflare with Email Routing enabled).
// Falls through to SendGrid or Resend. Deployer needs only ONE of these configured.
//
// Cloudflare Email Routing: add [[send_email]] binding in wrangler.toml + enable on domain
// SendGrid:                 wrangler secret put SENDGRID_KEY
// Resend:                   wrangler secret put RESEND_KEY

const emailTemplate = `<!DOCTYPE html>
<html>
<head>
    <title>[%title%]</title>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
    <div class="divPageBody">
        <p>Click the link below to [%operationToConfirm%].</p>
        <p><a href="[%confirmationUrl%]">[%confirmationUrl%]</a></p>
    </div>
</body>
</html>`;

export async function sendConfirmationEmail(config, providers, to, confirmUrl) {
    const htmlBody = emailTemplate
        .replace("[%title%]", config.confirmEmailSubject)
        .replace("[%operationToConfirm%]", config.operationToConfirm)
        .replace("[%confirmationUrl%]", confirmUrl);

    const textBody = `Confirm your ${config.operationToConfirm}:\n\n${confirmUrl}`;

    // 1. Cloudflare Email Routing — try first, zero-config if domain is on Cloudflare
    if (providers.sendEmailBinding) {
        try {
            await providers.sendEmailBinding.send({
                from: config.mailSender,
                to,
                subject: config.confirmEmailSubject,
                text: textBody,
                html: htmlBody
            });
            return;
        } catch (err) {
            console.log("Cloudflare Email Routing failed (may not be enabled on domain): " + err.message);
            // Fall through to next provider
        }
    }

    // 2. SendGrid
    if (providers.sendgridKey) {
        await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${providers.sendgridKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: to }] }],
                from: { email: config.mailSender },
                subject: config.confirmEmailSubject,
                content: [
                    { type: "text/plain", value: textBody },
                    { type: "text/html", value: htmlBody }
                ]
            })
        });
        return;
    }

    // 3. Resend
    if (providers.resendKey) {
        await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${providers.resendKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from: config.mailSender,
                to: [to],
                subject: config.confirmEmailSubject,
                text: textBody,
                html: htmlBody
            })
        });
        return;
    }

    throw new Error(
        "No email provider available. Configure one of:\n" +
        "  - Enable Email Routing on your Cloudflare domain (free, no third-party)\n" +
        "  - wrangler secret put SENDGRID_KEY\n" +
        "  - wrangler secret put RESEND_KEY"
    );
}
