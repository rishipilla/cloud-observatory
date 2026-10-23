import asyncio
import ipaddress
import socket
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import CheckResult, Endpoint, MonitoringEvent


class ProhibitedDestination(ValueError):
    pass


def validate_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ProhibitedDestination("Only HTTP and HTTPS destinations are allowed")
    if parsed.username or parsed.password:
        raise ProhibitedDestination("URLs must not contain credentials")
    if parsed.port not in {None, 80, 443}:
        raise ProhibitedDestination("Only standard HTTP and HTTPS ports are allowed")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        raise ProhibitedDestination("Local destinations are not allowed")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return
    if not address.is_global:
        raise ProhibitedDestination("Private or reserved IP destinations are not allowed")


class PublicResolver(AbstractResolver):
    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_UNSPEC):
        formatted_host = f"[{host}]" if ":" in host else host
        validate_url(f"http://{formatted_host}/")
        loop = asyncio.get_running_loop()
        records = await loop.getaddrinfo(host, port, family=family, type=socket.SOCK_STREAM)
        if not records:
            raise OSError("Destination did not resolve")
        results = []
        for record_family, _, proto, _, sockaddr in records:
            address = ipaddress.ip_address(sockaddr[0])
            if not address.is_global:
                raise ProhibitedDestination("Destination resolves to a private or reserved IP")
            results.append({
                "hostname": host,
                "host": str(address),
                "port": port,
                "family": record_family,
                "proto": proto,
                "flags": socket.AI_NUMERICHOST,
            })
        return results

    async def close(self) -> None:
        return None


async def request_status(url: str) -> tuple[int, float]:
    settings = get_settings()
    timeout = aiohttp.ClientTimeout(
        total=settings.check_total_timeout_seconds,
        connect=settings.check_connect_timeout_seconds,
    )
    connector = aiohttp.TCPConnector(resolver=PublicResolver(), use_dns_cache=False)
    started = time.perf_counter()
    async with aiohttp.ClientSession(
        connector=connector,
        timeout=timeout,
        trust_env=False,
        headers={"User-Agent": "CloudObservatory/1.0"},
    ) as client:
        current_url = url
        for redirect_count in range(settings.check_max_redirects + 1):
            validate_url(current_url)
            async with client.get(current_url, allow_redirects=False) as response:
                elapsed_ms = (time.perf_counter() - started) * 1000
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location or redirect_count >= settings.check_max_redirects:
                        return response.status, elapsed_ms
                    current_url = urljoin(current_url, location)
                    validate_url(current_url)
                    continue
                return response.status, elapsed_ms
    raise RuntimeError("Unexpected redirect handling state")


async def request_json(url: str) -> dict:
    settings = get_settings()
    timeout = aiohttp.ClientTimeout(
        total=settings.check_total_timeout_seconds,
        connect=settings.check_connect_timeout_seconds,
    )
    connector = aiohttp.TCPConnector(resolver=PublicResolver(), use_dns_cache=False)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout, trust_env=False) as client:
        current_url = url
        for redirect_count in range(settings.check_max_redirects + 1):
            validate_url(current_url)
            async with client.get(current_url, allow_redirects=False) as response:
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location or redirect_count >= settings.check_max_redirects:
                        raise aiohttp.ClientResponseError(
                            response.request_info,
                            response.history,
                            status=response.status,
                            message="Too many or invalid redirects",
                        )
                    current_url = urljoin(current_url, location)
                    validate_url(current_url)
                    continue
                response.raise_for_status()
                data = await response.json(content_type=None)
                if not isinstance(data, dict):
                    raise ValueError("Provider response was not a JSON object")
                return data
    raise RuntimeError("Unexpected redirect handling state")


class MonitoringService:
    async def check_endpoint(self, db: Session, endpoint: Endpoint) -> CheckResult:
        previous = db.scalar(
            select(CheckResult)
            .where(CheckResult.endpoint_id == endpoint.id)
            .order_by(CheckResult.checked_at.desc(), CheckResult.id.desc())
            .limit(1)
        )
        status_code: int | None = None
        elapsed_ms: float | None = None
        error: str | None = None
        started = time.perf_counter()
        try:
            status_code, elapsed_ms = await request_status(endpoint.url)
            success = 200 <= status_code < 400
            if not success:
                error = f"HTTP {status_code}"
        except ProhibitedDestination as exc:
            success = False
            error = str(exc)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            success = False
            error = "Request timed out" if isinstance(exc, asyncio.TimeoutError) else str(exc)[:500]
        except Exception as exc:
            success = False
            error = str(exc)[:500] or exc.__class__.__name__
        if elapsed_ms is None:
            elapsed_ms = (time.perf_counter() - started) * 1000

        result = CheckResult(
            endpoint_id=endpoint.id,
            status_code=status_code,
            elapsed_ms=elapsed_ms,
            success=success,
            error=error,
            checked_at=datetime.now(timezone.utc),
        )
        db.add(result)
        db.flush()
        if previous is None and not success:
            db.add(MonitoringEvent(
                endpoint_id=endpoint.id,
                type="failure",
                message=f"{endpoint.name} check failed: {error or 'unhealthy response'}",
            ))
        elif previous is not None and previous.success != success:
            event_type = "recovery" if success else "failure"
            message = f"{endpoint.name} recovered" if success else f"{endpoint.name} check failed: {error or 'unhealthy response'}"
            db.add(MonitoringEvent(endpoint_id=endpoint.id, type=event_type, message=message))
        db.commit()
        db.refresh(result)
        return result


monitoring_service = MonitoringService()
