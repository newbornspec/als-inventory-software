import { NextResponse } from 'next/server';

export async function POST() {
  const response = NextResponse.json({ message: 'Logged out' });
  response.cookies.delete('token');
  response.cookies.delete('refreshToken');
  return response;
}
