self.__BUILD_MANIFEST = {
  "__rewrites": {
    "afterFiles": [
      {
        "source": "/graphql"
      },
      {
        "source": "/auth/:path*"
      },
      {
        "source": "/webhook"
      },
      {
        "source": "/webhook/:path*"
      },
      {
        "source": "/socket.io"
      },
      {
        "source": "/socket.io/:path*"
      },
      {
        "source": "/inbox/conversations/:id/images"
      },
      {
        "source": "/inbox/conversations/:id/documents"
      },
      {
        "source": "/inbox/conversations/:id/voice"
      },
      {
        "source": "/inbox/conversations/:id/template"
      },
      {
        "source": "/templates"
      },
      {
        "source": "/templates/:id"
      },
      {
        "source": "/inbox/messages/:id/media"
      },
      {
        "source": "/me/avatar"
      },
      {
        "source": "/health"
      },
      {
        "source": "/reports/:path+"
      }
    ],
    "beforeFiles": [],
    "fallback": []
  },
  "sortedPages": [
    "/_app",
    "/_error"
  ]
};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()