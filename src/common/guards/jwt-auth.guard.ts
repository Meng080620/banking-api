import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Named wrapper around the passport strategy. Controllers depend on this class
 * rather than the magic string 'jwt', so renaming the strategy is one edit.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
