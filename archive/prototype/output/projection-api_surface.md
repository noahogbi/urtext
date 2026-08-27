# UserAuthAPI — API Reference

Base URL: http://localhost:3000

## Endpoints

### `POST /auth/register`

Register a new user account

**Request Body:**
```json
{
  "email": "str",
  "name": "str",
  "password": "str"
}
```

**Response:** User

### `POST /auth/login`

Authenticate and receive a JWT token

**Request Body:**
```json
{
  "email": "str",
  "password": "str"
}
```

**Response:** Token

### `GET /users/me`

Get the currently authenticated user's profile

**Response:** User

**Authentication:** Required (Bearer token)

### `GET /posts`

List all published posts

**Response:** [Post]

### `POST /posts`

Create a new post (authenticated)

**Request Body:**
```json
{
  "title": "str",
  "body": "str"
}
```

**Response:** Post

**Authentication:** Required (Bearer token)

### `GET /posts/:id`

Get a single post by ID

**Path Parameters:**
- `id`: str

**Response:** Post

### `DELETE /posts/:id`

Delete a post (authenticated, owner only)

**Path Parameters:**
- `id`: str

**Response:** void

**Authentication:** Required (Bearer token)
