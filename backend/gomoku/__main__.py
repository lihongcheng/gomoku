import copy
import os

import uvicorn

from .config import Settings


def main() -> None:
    settings = Settings()
    log_config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["loggers"]["gomoku"] = {
        "handlers": ["default"],
        "level": "INFO",
        "propagate": False,
    }
    uvicorn.run(
        "gomoku.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        workers=1,
        ws="websockets-sansio",
        ws_max_size=settings.max_message_bytes,
        ws_per_message_deflate=False,
        proxy_headers=False,
        access_log=False,
        log_config=log_config,
    )


if __name__ == "__main__":
    main()
