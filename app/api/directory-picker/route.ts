import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { directoryPicker } from "@/src/composition";

function invalidPickerBody(): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_INPUT",
        message: "Directory picker does not accept a request body.",
      },
    },
    { status: 400 },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (request.headers.has("content-type")) {
      return invalidPickerBody();
    }
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && declaredLength !== "0") {
      return invalidPickerBody();
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 0) {
      return invalidPickerBody();
    }

    const result = await directoryPicker.pickDirectory();
    if (result.kind === "cancelled") {
      return Response.json({ cancelled: true });
    }
    return Response.json({ path: result.path });
  } catch (error) {
    if (error instanceof directoryPicker.DirectoryPickerError) {
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: 503 },
      );
    }
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("POST /api/directory-picker")
    );
  }
}
