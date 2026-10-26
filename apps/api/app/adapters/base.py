from abc import ABC, abstractmethod

from app.schemas import SearchRequest, SearchResult


class ArchiveAdapter(ABC):
    slug: str
    name: str
    description: str
    region: str
    access: str = "free"
    homepage: str

    @abstractmethod
    async def search(self, request: SearchRequest) -> list[SearchResult]:
        """Translate a Foxtail search into the provider's dialect and normalize its results."""
        raise NotImplementedError
