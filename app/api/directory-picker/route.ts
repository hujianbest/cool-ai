import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { directoryPicker } from "@/src/composition";

export async function POST(): Promise<Response> {
  try {
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
